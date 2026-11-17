/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
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

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Host name and port to connect to; IPv6 literals lose their URL brackets. */
export function endpoint(url: URL): { host: string; port: number } {
  return { host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
}

/** Talks to the plugin over a small keep-alive pool, so the proxy never opens more sockets than configured. */
export class Upstream implements UpstreamPort {
  private readonly agent: HttpAgent;
  private readonly tls: boolean;

  constructor(private readonly base: URL, maxSockets: number, private readonly timeoutMs: number) {
    this.tls = base.protocol === "https:";
    const Agent = this.tls ? HttpsAgent : HttpAgent;
    this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: 8 });
  }

  request(method: string, pathAndQuery: string, headers: Record<string, string>, body?: Buffer): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      const req = (this.tls ? httpsRequest : httpRequest)(
        {
          ...endpoint(this.base),
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
