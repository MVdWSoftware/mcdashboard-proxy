/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { freshness, ResponseCache } from "./cache.js";
import type { Cached } from "./cache.js";
import { bucket, ClientIp } from "./clientip.js";
import type { Config } from "./config.js";
import { liveUpgrade } from "./live.js";
import { Metrics } from "./metrics.js";
import { Gate, RateLimiter } from "./ratelimit.js";
import { HttpError, readBody, sendJson, sendRaw } from "./respond.js";
import { Revocations } from "./revocations.js";
import { canonicalLanguages, canonicalQuery, match } from "./routes.js";
import type { Route } from "./routes.js";
import { ANONYMOUS, Scopes } from "./scope.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";
import { TunnelHub } from "./tunnel.js";
import { tunnelUpgrade } from "./tunnel-upgrade.js";
import { Upstream } from "./upstream.js";
import type { UpstreamPort, UpstreamResponse } from "./upstream.js";

const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "authorization", "content-type", "if-none-match", "user-agent"];

export interface Proxy {
  server: Server;
  metrics: Metrics;
  upstream: UpstreamPort;
  /** Present when the plugin connects in through the reverse tunnel (`TUNNEL_TOKEN`). */
  tunnel: TunnelHub | null;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export function createProxy(config: Config, store: Store, revocations: Revocations = new Revocations(store, config.revocationTtlS)): Proxy {
  const metrics = new Metrics();
  const clients = new ClientIp(config.trustedProxies);
  const limiter = new RateLimiter(store, config.limits.windowS);
  const scopes = new Scopes(config.jwtSecret, revocations, limiter, config.limits.badToken);
  const perIp = new Gate(config.maxConcurrentPerIp);
  const toPlugin = new Gate(config.maxUpstreamConcurrency);
  const cache = new ResponseCache(store, config.staleIfErrorS, config.cacheMaxBodyBytes);
  const deadMs = config.tunnelDeadS * 1000;
  const tunnel = config.tunnelToken
    ? new TunnelHub(config.upstreamTimeoutMs, config.maxLiveTotal, revocations, metrics, (m) => console.warn(m), {
        pingMs: Math.max(1000, Math.floor(deadMs / 3)),
        deadMs,
        helloMs: Math.min(10_000, deadMs),
      })
    : null;
  const upstream: UpstreamPort = tunnel ?? new Upstream(config.upstream, config.maxUpstreamConcurrency, config.upstreamTimeoutMs);
  const inflight = new Map<string, Promise<UpstreamResponse | Cached>>();

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, (req, res) => {
    const ip = clients.of(req);
    const key = bucket(ip);
    if (!perIp.enter(key)) {
      metrics.inc("mcdp_rejected_total", { reason: "concurrency" });
      sendJson(res, 429, { error: "too many concurrent requests" }, { "retry-after": "1" });
      return;
    }
    res.on("close", () => perIp.leave(key));
    handle(req, res, ip, key).catch((e: unknown) => {
      if (e instanceof HttpError) {
        metrics.inc("mcdp_rejected_total", { reason: e.reason });
        sendJson(res, e.status, { error: e.message }, e.headers);
      } else {
        metrics.inc("mcdp_errors_total");
        sendJson(res, 500, { error: "internal error" });
      }
    });
  });
  server.maxRequestsPerSocket = 1000;

  const onTunnel = tunnel ? tunnelUpgrade(config, tunnel, limiter, clients, metrics) : null;
  const onLive = liveUpgrade(config, limiter, clients, metrics, tunnel);
  server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if (onTunnel && (req.url as string).split("?")[0] === config.tunnelPath) onTunnel(req, socket, head);
    else onLive(req, socket, head);
  });

  async function handle(req: IncomingMessage, res: ServerResponse, ip: string, key: string): Promise<void> {
    const method = req.method as string;
    const rawUrl = req.url as string;
    if (rawUrl.length > config.maxUrlLength) throw new HttpError(414, "url too long");
    let url: URL;
    try {
      url = new URL(rawUrl, "http://proxy");
    } catch {
      throw new HttpError(400, "bad request target");
    }
    const m = match(method, url.pathname, url.searchParams);
    if (m.kind === "notFound") throw new HttpError(404, "not found");
    if (m.kind === "methodNotAllowed") throw new HttpError(405, "method not allowed", { allow: [...m.allow, ...(m.allow.includes("GET") ? ["HEAD"] : [])].join(", ") });
    if (m.kind === "badRequest") throw new HttpError(400, m.message);
    const route = m.route;

    const rl = await limiter.hit(route.rate, key, config.limits[route.rate]);
    if (!rl.allowed) throw new HttpError(429, "too many requests", { "retry-after": String(rl.retryAfterS) }, "rate_limit");

    const authz = req.headers.authorization;
    const scope = authz !== undefined && route.rate !== "auth" ? await scopes.of(authz, key) : ANONYMOUS;

    const query = canonicalQuery(url.searchParams);
    const target = url.pathname + (query ? "?" + query : "");
    const forward = forwardHeaders(req, ip);

    if (route.hasBody) {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "content-type must be application/json");
      const body = await readBody(req, config.maxBodyBytes);
      return reply(res, method, await callPlugin(method, target, forward, body), "bypass");
    }
    if (!route.cacheable) {
      const r = await callPlugin(method, target, forward);
      return reply(res, method, r, "bypass", req.headers["if-none-match"]);
    }
    await serveCached(req, res, method, url.pathname, query, target, forward, route, scope);
  }

  async function serveCached(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: string, target: string, forward: Record<string, string>, route: Route, scope: Scope): Promise<void> {
    const languages = canonicalLanguages(req.headers["accept-language"], config.languages);
    const ck = ResponseCache.key(path, query, languages, scope.key && `${scope.key}#${await revocations.generation()}`);
    const entry = await cache.get(ck);
    const inm = req.headers["if-none-match"];
    if (entry && ResponseCache.fresh(entry)) {
      metrics.inc("mcdp_cache_total", { result: "hit", route: route.name });
      return replyCached(res, method, entry, "hit", inm);
    }
    metrics.inc("mcdp_cache_total", { result: entry ? "stale" : "miss", route: route.name });

    // The plugin sees exactly the language the key holds, so it cannot answer in one the key does not tell apart.
    const { "accept-language": _al, "if-none-match": _inm, ...headers } = forward;
    if (languages) headers["accept-language"] = languages;
    if (entry?.headers.etag) headers["if-none-match"] = entry.headers.etag;
    let pending = inflight.get(ck);
    if (!pending) {
      pending = refresh(ck, target, headers, entry, scope).finally(() => inflight.delete(ck));
      inflight.set(ck, pending);
    } else {
      metrics.inc("mcdp_coalesced_total");
    }
    try {
      const r = await pending;
      if ("storedAt" in r) return replyCached(res, method, r, "hit; detail=revalidated", inm);
      return reply(res, method, r, "miss", inm);
    } catch (e) {
      if (entry && cache.usableStale(entry)) {
        metrics.inc("mcdp_stale_served_total");
        return replyCached(res, method, entry, "hit; detail=stale", inm);
      }
      throw e;
    }
  }

  async function refresh(ck: string, target: string, headers: Record<string, string>, entry: Cached | null, scope: Scope): Promise<UpstreamResponse | Cached> {
    const r = await callPlugin("GET", target, headers);
    if (r.status === 304 && entry) {
      const renewed = { ...entry, storedAt: Date.now() };
      await cache.put(ck, renewed).catch(() => {});
      return renewed;
    }
    if (r.status >= 500 && entry && cache.usableStale(entry)) throw new HttpError(r.status, "upstream error");
    const maxAge = freshness(r.status, r.headers, scope.kind, config.negativeTtlS);
    if (maxAge !== null) await cache.put(ck, { status: r.status, headers: r.headers, body: r.body, storedAt: Date.now(), maxAge }).catch(() => {});
    return r;
  }

  async function callPlugin(method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<UpstreamResponse> {
    if (!toPlugin.enter("all")) throw new HttpError(503, "server busy", { "retry-after": "1" }, "upstream_saturated");
    metrics.inc("mcdp_upstream_total");
    let r: UpstreamResponse;
    try {
      r = await upstream.request(method, target, headers, body);
    } catch {
      toPlugin.leave("all");
      metrics.inc("mcdp_upstream_errors_total");
      throw new HttpError(502, "server unavailable", { "retry-after": "5" });
    }
    toPlugin.leave("all");
    return r;
  }

  function reply(res: ServerResponse, method: string, r: UpstreamResponse, status: string, inm?: string): void {
    const etag = r.headers.etag;
    if (r.status === 200 && etag && inm === etag) return sendRaw(res, 304, r.headers, Buffer.alloc(0), method, status);
    sendRaw(res, r.status, r.headers, r.body, method, status);
  }

  function replyCached(res: ServerResponse, method: string, e: Cached, status: string, inm?: string): void {
    const headers = { ...e.headers, age: String(ResponseCache.age(e)) };
    if (e.status === 200 && e.headers.etag && inm === e.headers.etag) return sendRaw(res, 304, headers, Buffer.alloc(0), method, status);
    sendRaw(res, e.status, headers, e.body, method, status);
  }

  async function ready(): Promise<boolean> {
    try {
      if (tunnel && !tunnel.connected) return false;
      const r = await upstream.request("GET", "/v1/info", { accept: "application/json" });
      return r.status < 500 && (await store.ping());
    } catch {
      return false;
    }
  }

  function forwardHeaders(req: IncomingMessage, ip: string): Record<string, string> {
    const h: Record<string, string> = { "x-forwarded-for": ip, connection: "keep-alive" };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") h[name] = v.slice(0, 2048);
    }
    return h;
  }

  return {
    server,
    metrics,
    upstream,
    tunnel,
    ready,
    async close() {
      tunnel?.close();
      await new Promise<void>((r) => server.close(() => r()));
      upstream.close();
    },
  };
}
