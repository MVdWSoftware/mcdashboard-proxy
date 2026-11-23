/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { FillBudget } from "./budget.js";
import { canonicalPlayer, freshness, MAX_PLAYER_HEADER, ResponseCache } from "./cache.js";
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
import { ANONYMOUS, Scopes, withPlayer } from "./scope.js";
import type { Scope } from "./scope.js";
import type { Store } from "./store.js";
import { TunnelHub, TUNNEL_FEATURES } from "./tunnel.js";
import { tunnelUpgrade } from "./tunnel-upgrade.js";
import { Upstream } from "./upstream.js";
import type { UpstreamPort, UpstreamResponse } from "./upstream.js";

const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "authorization", "content-type", "if-none-match", "user-agent",
  "x-mcdashboard-attestation", "x-mcdashboard-entitlement", "x-mcdashboard-player", "x-mcdashboard-purpose"];

/**
 * Headers that shape an answer beyond the cache key: the plugin refuses or treats a client differently by User-Agent,
 * verifies an attestation, and may hide features by entitlement or handle a purpose differently. Two requests that
 * differ in one of them must never share an in-flight answer, so they are part of the coalescing key.
 */
const COALESCE_HEADERS = ["user-agent", "x-mcdashboard-attestation", "x-mcdashboard-purpose", "x-mcdashboard-entitlement"];

/** Node's own header limit is 8 KiB; 4096 matches the attestation the plugin accepts, and hosts are at most 255. */
const MAX_FORWARDED_HEADER = 4096;
const HOST = /^[A-Za-z0-9._~:[\]-]{1,255}$/;

/** How long one client's cache-fill budget lasts; entries are per node, like the concurrency gates. */
const FILL_WINDOW_MS = 5 * 60_000;

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
  const fills = new FillBudget(config.maxCacheKeysPerClient, FILL_WINDOW_MS);

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
      // Only the path of a request target is used; the base just makes relative targets parseable, so no scheme
      // (or reachable host) is involved and none is contacted.
      url = new URL(rawUrl, "https://proxy.invalid");
    } catch {
      throw new HttpError(400, "bad request target");
    }
    // CORS preflight, answered as the plugin does: no route, no upstream request, the same headers on every path.
    if (method === "OPTIONS") {
      const rl = await limiter.hit("read", key, config.limits.read);
      if (!rl.allowed) throw new HttpError(429, "too many requests", { "retry-after": String(rl.retryAfterS) }, "rate_limit");
      return sendRaw(res, 204, {}, Buffer.alloc(0), method, "bypass");
    }
    const m = match(method, url.pathname, url.searchParams);
    if (m.kind === "notFound") throw new HttpError(404, "not found");
    if (m.kind === "methodNotAllowed") throw new HttpError(405, "method not allowed", { allow: [...m.allow, ...(m.allow.includes("GET") ? ["HEAD"] : [])].join(", ") });
    if (m.kind === "badRequest") throw new HttpError(400, m.message);
    const route = m.route;

    const rl = await limiter.hit(route.rate, key, config.limits[route.rate]);
    if (!rl.allowed) throw new HttpError(429, "too many requests", { "retry-after": String(rl.retryAfterS) }, "rate_limit");

    const playerHeader = req.headers["x-mcdashboard-player"];
    const player = canonicalPlayer(typeof playerHeader === "string" ? playerHeader : undefined);
    if (player.length > MAX_PLAYER_HEADER) throw new HttpError(400, "X-MCDashboard-Player is too long");

    const authz = req.headers.authorization;
    const scope = withPlayer(authz !== undefined && route.rate !== "auth" ? await scopes.of(authz, key) : ANONYMOUS, player);

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
    await serveCached(req, res, method, url.pathname, query, target, forward, route, scope, player, key);
  }

  async function serveCached(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: string, target: string, forward: Record<string, string>, route: Route, scope: Scope, player: string, client: string): Promise<void> {
    const languages = canonicalLanguages(req.headers["accept-language"], config.languages);
    const ck = ResponseCache.key(path, query, languages, scope.key && `${scope.key}#${await revocations.generation()}`, player);
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
    const pendingKey = coalesceKey(ck, forward);
    let pending = inflight.get(pendingKey);
    if (!pending) {
      pending = refresh(ck, target, headers, entry, scope, client).finally(() => inflight.delete(pendingKey));
      inflight.set(pendingKey, pending);
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

  /**
   * Two requests may share one upstream call only when they would get the same answer: the cache key already covers
   * path, query, language, scope and player, and the digest below adds the headers that change what the plugin
   * answers for one caller (User-Agent policy, attestation, entitlement, purpose).
   */
  function coalesceKey(ck: string, forward: Record<string, string>): string {
    const vary = COALESCE_HEADERS.map((n) => `${n}=${forward[n] ?? ""}`).join("\n");
    return `${ck}#${createHash("sha256").update(vary).digest("base64url").slice(0, 22)}`;
  }

  async function refresh(ck: string, target: string, headers: Record<string, string>, entry: Cached | null, scope: Scope, client: string): Promise<UpstreamResponse | Cached> {
    const r = await callPlugin("GET", target, headers);
    if (r.status === 304 && entry) {
      const renewed = { ...entry, storedAt: Date.now() };
      await cache.put(ck, renewed).catch(() => {});
      return renewed;
    }
    if (r.status >= 500 && entry && cache.usableStale(entry)) throw new HttpError(r.status, "upstream error");
    const maxAge = freshness(r.status, r.headers, scope.kind, config.negativeTtlS);
    // A renewal of an entry that exists costs no new shared memory; a new key must fit in this client's budget.
    const mayStore = entry !== null || fills.allow(client, ck);
    if (maxAge !== null && mayStore) await cache.put(ck, { status: r.status, headers: r.headers, body: r.body, storedAt: Date.now(), maxAge }).catch(() => {});
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
    // A 5xx body is the plugin's internals (stack traces, host names): never forwarded. Errors are never cacheable,
    // even when the plugin forgot to say so.
    if (r.status >= 500) {
      const { etag: _etag, ...rest } = r.headers;
      const headers = { ...rest, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      return sendRaw(res, r.status, headers, Buffer.from('{"error":"upstream error"}'), method, status);
    }
    if (r.status >= 400) return sendRaw(res, r.status, { ...r.headers, "cache-control": "no-store" }, r.body, method, status);
    sendRaw(res, r.status, r.headers, r.body, method, status);
  }

  function replyCached(res: ServerResponse, method: string, e: Cached, status: string, inm?: string): void {
    const headers = { ...e.headers, age: String(ResponseCache.age(e)), ...(e.status >= 400 ? { "cache-control": "no-store" } : {}) };
    if (e.status === 200 && e.headers.etag && inm === e.headers.etag) return sendRaw(res, 304, headers, Buffer.alloc(0), method, status);
    sendRaw(res, e.status, headers, e.body, method, status);
  }

  async function ready(): Promise<boolean> {
    try {
      if (tunnel && !tunnel.connected) return false;
      const r = await upstream.request("GET", "/v1/info", { accept: "application/json" });
      // Redis is deliberately not required: the fallback store keeps cache and limits in memory, and taking every node
      // out of the load balancer on a Redis hiccup is worse than serving from memory. `mcdp_redis_up` tracks it.
      return r.status < 500;
    } catch {
      return false;
    }
  }

  function forwardHeaders(req: IncomingMessage, ip: string): Record<string, string> {
    const h: Record<string, string> = {
      "x-forwarded-for": ip,
      connection: "keep-alive",
      // Tells the plugin that a proxy routes this request and which API features it can carry. A client that copies
      // these headers only hides features from itself; the proxy never lets a client's own value through.
      "x-mcdashboard-via": "proxy",
      "x-mcdashboard-proxy-features": TUNNEL_FEATURES.join(","),
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string") h[name] = v.slice(0, MAX_FORWARDED_HEADER);
    }
    // The plugin verifies client attestations against the Host the client used (its `security.client-verification.hosts`)
    // and would otherwise see the proxy's own address. Host is also what a terminator / CDN routes on.
    const host = req.headers.host;
    if (host && HOST.test(host)) {
      h.host = host;
      h["x-forwarded-host"] = host;
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
