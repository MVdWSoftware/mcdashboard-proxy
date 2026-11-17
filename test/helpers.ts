/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHmac } from "node:crypto";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createProxy } from "../src/proxy.js";
import type { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";
import type { Store } from "../src/store.js";

export interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** An HS256 token signed with `key`; `header` can be replaced to test algorithm checks. */
export function jwt(claims: Record<string, unknown>, key: Buffer, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** Stands in for the MCDashboard plugin: same cache headers the plugin's HttpApi.cacheable sets. */
export async function fakePlugin(handler?: (req: IncomingMessage, res: ServerResponse) => boolean | void) {
  const seen: Seen[] = [];
  let delayMs = 0;
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (handler?.(req, res)) return;
    const respond = () => {
      const authed = req.headers.authorization !== undefined;
      const body = JSON.stringify([{ n: authed ? "player-name" : "online", vs: authed ? req.headers.authorization : "anon" }]);
      if (req.url?.startsWith("/v1/placeholders/missing")) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown placeholder"}');
        return;
      }
      const etag = '"abc"';
      res.setHeader("cache-control", `${authed ? "private" : "public"}, max-age=2`);
      res.setHeader("etag", etag);
      res.setHeader("vary", "Authorization");
      res.setHeader("content-type", "application/senml+json; charset=utf-8");
      res.setHeader("server", "secret-internal");
      if (req.headers["if-none-match"] === etag) return void res.writeHead(304).end();
      res.end(body);
    };
    delayMs ? setTimeout(respond, delayMs) : respond();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    port: (server.address() as AddressInfo).port,
    setDelay: (ms: number) => (delayMs = ms),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export async function startProxy(env: Record<string, string>, store: Store = new MemoryStore(), revocations?: Revocations) {
  const proxy = createProxy(loadConfig({ UPSTREAM_URL: "http://127.0.0.1:1", ...env }), store, revocations);
  await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", r));
  const port = (proxy.server.address() as AddressInfo).port;
  return { proxy, port, close: () => proxy.close() };
}

export function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: body ? { "content-length": Buffer.byteLength(body), ...headers } : headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
