import http from "node:http";
import https from "node:https";
import { pick } from "./cache.js";

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Where requests for the plugin go: a keep-alive HTTP pool, or the reverse tunnel the plugin opened. */
export interface UpstreamPort {
  request(method: string, pathAndQuery: string, headers: Record<string, string>, body?: Buffer): Promise<UpstreamResponse>;
  close(): void;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Talks to the plugin over a small keep-alive pool, so the proxy never opens more sockets than configured. */
export class Upstream implements UpstreamPort {
  private readonly agent: http.Agent;

  constructor(private readonly base: URL, maxSockets: number, private readonly timeoutMs: number) {
    const Agent = base.protocol === "https:" ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: 8 });
  }

  request(method: string, pathAndQuery: string, headers: Record<string, string>, body?: Buffer): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      const lib = this.base.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          host: this.base.hostname,
          port: this.base.port || (this.base.protocol === "https:" ? 443 : 80),
          method,
          path: pathAndQuery,
          headers: body ? { ...headers, "content-length": String(body.length) } : headers,
          agent: this.agent,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) req.destroy(new Error("upstream response too large"));
            else chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: pick(res.headers), body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("upstream timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}
