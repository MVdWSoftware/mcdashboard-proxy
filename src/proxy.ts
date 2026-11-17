import { createHash } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { bucket, ClientIp } from "./clientip.js";
import { bearer, peekDeviceId, verifyAccessToken } from "./jwt.js";
import { Revocations } from "./revocations.js";
import { canonicalLanguages, canonicalQuery, match } from "./routes.js";
import type { Route } from "./routes.js";
import { Gate, RateLimiter } from "./ratelimit.js";
import { freshness, ResponseCache } from "./cache.js";
import type { Cached } from "./cache.js";
import { Upstream } from "./upstream.js";
import type { UpstreamPort, UpstreamResponse } from "./upstream.js";
import { Metrics } from "./metrics.js";
import type { Store } from "./store.js";
import { attachLive } from "./live.js";
import { attachTunnel, TunnelHub } from "./tunnel.js";

const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "authorization", "content-type", "if-none-match", "user-agent"];

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

export interface Proxy {
  server: http.Server;
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
  const perIp = new Gate(config.maxConcurrentPerIp);
  const toPlugin = new Gate(config.maxUpstreamConcurrency);
  const cache = new ResponseCache(store, config.staleIfErrorS, config.cacheMaxBodyBytes);
  const tunnel = config.tunnelToken ? new TunnelHub(config.upstreamTimeoutMs, config.maxLiveTotal, revocations, metrics, (m) => console.warn(m), { pingMs: Math.max(1000, Math.floor(config.tunnelDeadS * 1000 / 3)), deadMs: config.tunnelDeadS * 1000, helloMs: Math.min(10_000, config.tunnelDeadS * 1000) }) : null;
  const upstream: UpstreamPort = tunnel ?? new Upstream(config.upstream, config.maxUpstreamConcurrency, config.upstreamTimeoutMs);
  const inflight = new Map<string, Promise<UpstreamResponse | Cached>>();

  const server = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 },
    (req, res) => {
      const ip = clients.resolve(req.socket.remoteAddress ?? "", firstHeader(req.headers["x-forwarded-for"]));
      const key = bucket(ip);
      if (!perIp.enter(key)) {
        metrics.inc("mcdp_rejected_total", { reason: "concurrency" });
        send(res, 429, { error: "too many concurrent requests" }, { "retry-after": "1" });
        return;
      }
      res.on("close", () => perIp.leave(key));
      handle(req, res, ip, key).catch((e: unknown) => {
        if (e instanceof HttpError) {
          metrics.inc("mcdp_rejected_total", { reason: String(e.status) });
          send(res, e.status, { error: e.message }, e.headers);
        } else {
          metrics.inc("mcdp_errors_total");
          send(res, 500, { error: "internal error" });
        }
      });
    },
  );
  server.maxRequestsPerSocket = 1000;
  if (tunnel) attachTunnel(server, config, tunnel, limiter, clients, metrics);
  attachLive(server, config, limiter, clients, metrics, tunnel);

  async function handle(req: IncomingMessage, res: ServerResponse, ip: string, key: string): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    if (rawUrl.length > config.maxUrlLength) throw new HttpError(414, "url too long");
    const url = new URL(rawUrl, "http://proxy");
    const m = match(method, url.pathname, url.searchParams);
    if (m.kind === "notFound") throw new HttpError(404, "not found");
    if (m.kind === "methodNotAllowed") throw new HttpError(405, "method not allowed", { allow: [...m.allow, ...(m.allow.includes("GET") ? ["HEAD"] : [])].join(", ") });
    if (m.kind === "badRequest") throw new HttpError(400, m.message);
    const route = m.route;

    const limit = config.limits[route.rate];
    const rl = await limiter.hit(route.rate, key, limit);
    if (!rl.allowed) {
      metrics.inc("mcdp_rejected_total", { reason: "rate_limit" });
      throw new HttpError(429, "too many requests", { "retry-after": String(rl.retryAfterS) });
    }

    const authz = req.headers.authorization;
    const scope = authz !== undefined && route.rate !== "auth" ? await identify(authz, key) : "";

    const query = canonicalQuery(url.searchParams);
    const target = url.pathname + (query ? "?" + query : "");
    const forward = forwardHeaders(req, ip);

    if (route.hasBody && method !== "DELETE") {
      const body = await readBody(req, config.maxBodyBytes);
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "content-type must be application/json");
      const r = await callPlugin(method, target, forward, body);
      return reply(res, method, r, "BYPASS");
    }

    const cacheable = route.cacheable && (method === "GET" || method === "HEAD");
    if (!cacheable) {
      const r = await callPlugin(method === "HEAD" ? "GET" : method, target, forward);
      return reply(res, method, r, "BYPASS", req.headers["if-none-match"]);
    }
    await serveCached(req, res, method, url.pathname, query, target, forward, route, scope);
  }

  /**
   * Who is asking, as a cache scope. With the secret the token is verified and the scope is the player,
   * so a player's devices share entries; without it the scope is the token itself (still never shared
   * with anyone else). Invalid tokens are refused and counted.
   */
  async function identify(authz: string, key: string): Promise<string> {
    const token = bearer(authz);
    const verdict = token === null ? ({ ok: false, reason: "invalid authorization header" } as const)
      : config.jwtSecret ? verifyAccessToken(token, config.jwtSecret) : null;
    if (token !== null && (verdict === null || verdict.ok)) {
      // A device that was revoked is refused here, before any cache is consulted: the player's other devices share
      // the player scope and must keep working, so the entries cannot simply be dropped.
      const device = verdict?.ok ? verdict.deviceId : peekDeviceId(token);
      if (device && (await revocations.isDenied(device))) {
        metrics.inc("mcdp_rejected_total", { reason: "revoked" });
        throw new HttpError(401, "device revoked", { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      if (verdict?.ok && verdict.player) return "p:" + verdict.player;
      return "t:" + createHash("sha256").update(token).digest("base64url");
    }
    if (!verdict || verdict.ok) throw new HttpError(401, "invalid authorization header");
    const bad = await limiter.hit("badtoken", key, config.limits.badToken);
    metrics.inc("mcdp_rejected_total", { reason: "bad_token" });
    if (!bad.allowed) throw new HttpError(429, "too many invalid tokens", { "retry-after": String(bad.retryAfterS) });
    throw new HttpError(401, verdict.reason, { "www-authenticate": 'Bearer error="invalid_token"' });
  }

  async function serveCached(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: string, target: string, forward: Record<string, string>, route: Route, scope: string): Promise<void> {
    const languages = canonicalLanguages(firstHeader(req.headers["accept-language"]), config.languages);
    const ck = ResponseCache.key(path, query, languages, scope && `${scope}#${await revocations.generation()}`);
    const entry = await cache.get(ck);
    const inm = req.headers["if-none-match"];
    if (entry && ResponseCache.fresh(entry)) {
      metrics.inc("mcdp_cache_total", { result: "hit", route: route.name });
      return replyCached(res, method, entry, "hit", inm);
    }
    metrics.inc("mcdp_cache_total", { result: entry ? "stale" : "miss", route: route.name });

    // The cache key already carries the language, so the plugin is asked in that same language.
    const headers: Record<string, string> = { ...forward, ...(languages ? { "accept-language": languages } : {}) };
    delete headers["if-none-match"];
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
      return reply(res, method, r, "MISS", inm);
    } catch (e) {
      if (entry && cache.usableStale(entry)) {
        metrics.inc("mcdp_stale_served_total");
        return replyCached(res, method, entry, "hit; detail=stale", inm);
      }
      throw e;
    }
  }

  async function refresh(ck: string, target: string, headers: Record<string, string>, entry: Cached | null, scope: string): Promise<UpstreamResponse | Cached> {
    const r = await callPlugin("GET", target, headers);
    if (r.status === 304 && entry) {
      const renewed = { ...entry, storedAt: Date.now() };
      await cache.put(ck, renewed).catch(() => {});
      return renewed;
    }
    if (r.status >= 500 && entry && cache.usableStale(entry)) throw new HttpError(r.status, "upstream error");
    // Errors for a token nobody verified are not remembered, so random tokens cannot fill the cache.
    const negative = scope.startsWith("t:") && config.jwtSecret === null ? 0 : config.negativeTtlS;
    const maxAge = freshness(r.status, r.headers, negative, scope !== "");
    if (maxAge !== null) await cache.put(ck, { status: r.status, headers: r.headers, body: r.body, storedAt: Date.now(), maxAge }).catch(() => {});
    return r;
  }

  async function callPlugin(method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<UpstreamResponse> {
    if (!toPlugin.enter("all")) {
      metrics.inc("mcdp_rejected_total", { reason: "upstream_saturated" });
      throw new HttpError(503, "server busy", { "retry-after": "1" });
    }
    metrics.inc("mcdp_upstream_total");
    try {
      return await upstream.request(method, target, headers, body);
    } catch {
      metrics.inc("mcdp_upstream_errors_total");
      throw new HttpError(502, "server unavailable", { "retry-after": "5" });
    } finally {
      toPlugin.leave("all");
    }
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

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(",") : v;
}

const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "cache-control": "no-store" };

function send(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(json));
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": body.length, connection: status === 429 ? "close" : "keep-alive", ...extra });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer, method: string, cacheStatus: string): void {
  if (res.headersSent) return;
  const out: Record<string, string | number> = { "x-content-type-options": "nosniff", ...headers, "cache-status": `mcdashboard-proxy; ${cacheStatus.toLowerCase()}` };
  if (status !== 304) out["content-length"] = body.length;
  res.writeHead(status, out);
  res.end(method === "HEAD" || status === 304 ? undefined : body);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > max) return reject(new HttpError(413, "body too large"));
    if (req.headers["content-length"] === undefined && req.headers["transfer-encoding"] === undefined) return reject(new HttpError(411, "content-length required"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.pause();
        reject(new HttpError(413, "body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
