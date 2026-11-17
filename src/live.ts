/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { connect as tcpConnect } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { bucket } from "./clientip.js";
import type { ClientIp } from "./clientip.js";
import type { Config } from "./config.js";
import type { Metrics } from "./metrics.js";
import { Gate } from "./ratelimit.js";
import type { RateLimiter } from "./ratelimit.js";
import type { TunnelHub } from "./tunnel.js";
import { endpoint } from "./upstream.js";
import { refuseUpgrade, webSocketKey } from "./websocket.js";
import type { UpgradeHandler } from "./websocket.js";

const IDLE_MS = 5 * 60_000;

type Stream = Duplex & { setTimeout(ms: number, cb?: () => void): unknown };

/**
 * Relays `GET /v1/live` WebSocket upgrades to the plugin's live port (or a tunnel channel). The proxy does not parse
 * frames; it bounds connections per client and in total, rate limits handshakes and drops idle connections.
 */
export function liveUpgrade(config: Config, limiter: RateLimiter, clients: ClientIp, metrics: Metrics, hub: TunnelHub | null): UpgradeHandler {
  const perIp = new Gate(config.maxLivePerIp);
  let total = 0;

  return (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    const key = webSocketKey(req);
    if (path !== "/v1/live" || !key) return refuseUpgrade(socket, "404 Not Found");
    const client = bucket(clients.of(req));
    if (total >= config.maxLiveTotal || !perIp.enter(client)) {
      metrics.inc("mcdp_rejected_total", { reason: "live_connections" });
      return refuseUpgrade(socket, "429 Too Many Requests", "Retry-After: 5\r\n");
    }
    total++;
    const release = (): void => {
      total--;
      perIp.leave(client);
    };
    limiter.hit("live", client, config.limits.read).then((rl) => {
      if (!rl.allowed) {
        release();
        metrics.inc("mcdp_rejected_total", { reason: "rate_limit" });
        return refuseUpgrade(socket, "429 Too Many Requests", `Retry-After: ${rl.retryAfterS}\r\n`);
      }
      const target = config.liveUpstream;
      const tls = !hub && target.protocol === "https:";
      let back: Stream;
      if (hub) {
        const channel = hub.openChannel();
        if (!channel) {
          release();
          return refuseUpgrade(socket, "503 Service Unavailable", "Retry-After: 5\r\n");
        }
        back = channel;
      } else {
        const { host, port } = endpoint(target);
        back = tls ? tlsConnect({ host, port, servername: host }) : tcpConnect(port, host);
      }
      let closed = false;
      const done = (): void => {
        if (closed) return;
        closed = true;
        release();
        socket.destroy();
        back.destroy();
      };
      back.once(tls ? "secureConnect" : "connect", () => {
        const protocols = req.headers["sec-websocket-protocol"];
        // The plugin only serves the official app's User-Agent on the live feed too.
        const agent = req.headers["user-agent"];
        back.write(
          `GET /v1/live HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${String(req.headers["sec-websocket-version"] ?? "13").slice(0, 8)}\r\n` +
            (typeof protocols === "string" ? `Sec-WebSocket-Protocol: ${oneLine(protocols)}\r\n` : "") +
            (typeof agent === "string" ? `User-Agent: ${oneLine(agent)}\r\n` : "") +
            "\r\n",
        );
        if (head.length) back.write(head);
        socket.pipe(back);
        back.pipe(socket);
        metrics.inc("mcdp_live_total");
      });
      for (const s of [socket as Stream, back]) {
        s.setTimeout(IDLE_MS, done);
        s.on("close", done);
        s.on("error", done);
      }
    }).catch(() => {
      release();
      refuseUpgrade(socket, "503 Service Unavailable");
    });
  };
}

function oneLine(v: string): string {
  return v.slice(0, 200).replace(/[\r\n]/g, "");
}
