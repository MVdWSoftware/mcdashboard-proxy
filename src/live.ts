import net from "node:net";
import tls from "node:tls";
import type http from "node:http";
import type { Config } from "./config.js";
import { bucket, ClientIp } from "./clientip.js";
import { Gate, RateLimiter } from "./ratelimit.js";
import type { Metrics } from "./metrics.js";
import type { TunnelHub } from "./tunnel.js";
import type { Duplex } from "node:stream";

const IDLE_MS = 5 * 60_000;

/**
 * Tunnels `GET /v1/live` WebSocket upgrades to the plugin's live port. The proxy does not parse
 * frames; it bounds connections per client and in total, rate limits handshakes and drops idle tunnels.
 */
export function attachLive(server: http.Server, config: Config, limiter: RateLimiter, clients: ClientIp, metrics: Metrics, hub: TunnelHub | null = null): void {
  const perIp = new Gate(config.maxLivePerIp);
  let total = 0;

  server.on("upgrade", (req, socket, head) => {
    const refuse = (status: string, extra = "") => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
    };
    socket.on("error", () => socket.destroy());
    const path = (req.url ?? "").split("?")[0];
    const key = req.headers["sec-websocket-key"];
    if (hub && path === config.tunnelPath) return; // the tunnel's own upgrade, see attachTunnel
    if (path !== "/v1/live" || req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket" || typeof key !== "string" || key.length > 64) {
      return refuse("404 Not Found");
    }
    const client = bucket(clients.resolve(req.socket.remoteAddress ?? "", firstValue(req.headers["x-forwarded-for"])));
    if (total >= config.maxLiveTotal || !perIp.enter(client)) {
      metrics.inc("mcdp_rejected_total", { reason: "live_connections" });
      return refuse("429 Too Many Requests", "Retry-After: 5\r\n");
    }
    limiter.hit("live", client, config.limits.read).then((rl) => {
      if (!rl.allowed) {
        perIp.leave(client);
        metrics.inc("mcdp_rejected_total", { reason: "rate_limit" });
        return refuse("429 Too Many Requests", `Retry-After: ${rl.retryAfterS}\r\n`);
      }
      const target = config.liveUpstream;
      const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
      let back: Duplex & { setTimeout(ms: number, cb?: () => void): unknown };
      if (hub) {
        const channel = hub.openChannel();
        if (!channel) {
          perIp.leave(client);
          return refuse("503 Service Unavailable", "Retry-After: 5\r\n");
        }
        back = channel;
      } else {
        back = target.protocol === "https:" ? tls.connect({ host: target.hostname, port, servername: target.hostname }) : net.connect(port, target.hostname);
      }
      total++;
      let closed = false;
      const done = (): void => {
        if (closed) return;
        closed = true;
        total--;
        perIp.leave(client);
        socket.destroy();
        back.destroy();
      };
      back.once(!hub && target.protocol === "https:" ? "secureConnect" : "connect", () => {
        const protocols = req.headers["sec-websocket-protocol"];
        // The plugin identifies the official app by its User-Agent on the live feed too, so it has to arrive.
        const agent = req.headers["user-agent"];
        back.write(
          `GET /v1/live HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${String(req.headers["sec-websocket-version"] ?? "13").slice(0, 8)}\r\n` +
            (typeof protocols === "string" ? `Sec-WebSocket-Protocol: ${protocols.slice(0, 200).replace(/[\r\n]/g, "")}\r\n` : "") +
            (typeof agent === "string" ? `User-Agent: ${agent.slice(0, 200).replace(/[\r\n]/g, "")}\r\n` : "") +
            "\r\n",
        );
        if (head.length) back.write(head);
        socket.pipe(back);
        back.pipe(socket);
        metrics.inc("mcdp_live_total");
      });
      for (const s of [socket, back] as (Duplex & { setTimeout(ms: number, cb?: () => void): unknown })[]) {
        s.setTimeout(IDLE_MS, done);
        s.on("close", done);
        s.on("error", done);
      }
    }).catch(() => refuse("503 Service Unavailable"));
  });
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(",") : v;
}
