/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface Config {
  listenHost: string;
  listenPort: number;
  adminHost: string;
  adminPort: number;
  upstream: URL;
  liveUpstream: URL;
  redisUrl: string | null;
  keyPrefix: string;
  /** Peers whose X-Forwarded-For is believed (CIDR or address). */
  trustedProxies: string[];
  /** Base64 contents of the plugin's secret.key; enables the edge token check. */
  jwtSecret: Buffer | null;
  languages: string[];
  maxBodyBytes: number;
  maxUrlLength: number;
  upstreamTimeoutMs: number;
  maxUpstreamConcurrency: number;
  maxConcurrentPerIp: number;
  maxLivePerIp: number;
  maxLiveTotal: number;
  negativeTtlS: number;
  staleIfErrorS: number;
  cacheMaxBodyBytes: number;
  /** When set the plugin dials in, and `upstream`, `liveUpstream` and `eventsToken` are not used. */
  tunnelToken: string | null;
  tunnelPath: string;
  /** Seconds of silence after which the tunnel is considered dead and dropped (pings go out every third of it). */
  tunnelDeadS: number;
  /** Addresses (CIDR or single) allowed to open the tunnel; empty = any holder of the key. */
  tunnelAllowedIps: string[];
  /** Token for the plugin's GET /v1/events stream (`events.token`); enables the stream. */
  eventsToken: string | null;
  /** Shared secret of the plugin's `events.webhooks` entry; enables the webhook receiver when the port is set. */
  webhookSecret: string | null;
  webhookHost: string;
  webhookPort: number;
  webhookToleranceS: number;
  /** How long a revoked device stays on the deny list (at least the plugin's access-token lifetime). */
  revocationTtlS: number;
  limits: { read: number; auth: number; write: number; badToken: number; windowS: number };
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function url(env: Env, name: string, def: string): URL {
  const u = new URL(env[name] || def);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${name} must be http(s)`);
  return u;
}

/** Reads the configuration from environment variables (documented in docs/configuration.md). */
export function loadConfig(env: Env = process.env): Config {
  const secret = env.MCD_JWT_SECRET?.trim();
  let jwtSecret: Buffer | null = null;
  if (secret) {
    jwtSecret = Buffer.from(secret, "base64");
    if (jwtSecret.length < 32) throw new Error("MCD_JWT_SECRET must be the base64 secret.key (at least 32 bytes)");
  }
  const webhookSecret = env.WEBHOOK_SECRET?.trim();
  if (webhookSecret && webhookSecret.length < 16) throw new Error("WEBHOOK_SECRET must be at least 16 characters");
  if (int(env, "WEBHOOK_PORT", 0, 0) > 0 && !webhookSecret) throw new Error("WEBHOOK_PORT needs WEBHOOK_SECRET");
  const tunnelToken = env.TUNNEL_TOKEN?.trim();
  if (tunnelToken && tunnelToken.length < 32) throw new Error("TUNNEL_TOKEN must be at least 32 characters (use a random key)");
  const tunnelPath = env.TUNNEL_PATH || "/tunnel";
  if (!/^\/[A-Za-z0-9._~/-]{1,64}$/.test(tunnelPath) || tunnelPath.startsWith("/v1")) throw new Error("TUNNEL_PATH must be a plain path outside /v1");
  return {
    listenHost: env.LISTEN_HOST || "0.0.0.0",
    listenPort: int(env, "LISTEN_PORT", 8080, 1),
    adminHost: env.ADMIN_HOST || "127.0.0.1",
    adminPort: int(env, "ADMIN_PORT", 9090, 0),
    upstream: url(env, "UPSTREAM_URL", "http://127.0.0.1:1553"),
    liveUpstream: url(env, "UPSTREAM_LIVE_URL", "http://127.0.0.1:1554"),
    redisUrl: env.REDIS_URL || null,
    keyPrefix: env.REDIS_KEY_PREFIX || "mcdp:",
    trustedProxies: (env.TRUSTED_PROXIES || "").split(",").map((s) => s.trim()).filter(Boolean),
    jwtSecret,
    languages: (env.LANGUAGES || "en,nl,fr,de,es").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 32 * 1024, 1),
    maxUrlLength: int(env, "MAX_URL_LENGTH", 4096, 64),
    upstreamTimeoutMs: int(env, "UPSTREAM_TIMEOUT_MS", 5000, 100),
    maxUpstreamConcurrency: int(env, "MAX_UPSTREAM_CONCURRENCY", 32, 1),
    maxConcurrentPerIp: int(env, "MAX_CONCURRENT_PER_IP", 20, 1),
    maxLivePerIp: int(env, "MAX_LIVE_PER_IP", 5, 1),
    maxLiveTotal: int(env, "MAX_LIVE_TOTAL", 500, 1),
    negativeTtlS: int(env, "NEGATIVE_TTL_S", 5, 0),
    staleIfErrorS: int(env, "STALE_IF_ERROR_S", 300, 0),
    cacheMaxBodyBytes: int(env, "CACHE_MAX_BODY_BYTES", 512 * 1024, 1),
    tunnelToken: tunnelToken || null,
    tunnelPath,
    tunnelDeadS: int(env, "TUNNEL_DEAD_S", 60, 3),
    tunnelAllowedIps: (env.TUNNEL_ALLOWED_IPS || "").split(",").map((x) => x.trim()).filter(Boolean),
    eventsToken: env.EVENTS_TOKEN?.trim() || null,
    webhookSecret: webhookSecret || null,
    webhookHost: env.WEBHOOK_HOST || "127.0.0.1",
    webhookPort: int(env, "WEBHOOK_PORT", 0, 0),
    webhookToleranceS: int(env, "WEBHOOK_TOLERANCE_S", 300, 1),
    revocationTtlS: int(env, "REVOCATION_TTL_S", 3600, 60),
    limits: {
      read: int(env, "RATE_READ", 300, 1),
      auth: int(env, "RATE_AUTH", 10, 1),
      write: int(env, "RATE_WRITE", 6, 1),
      badToken: int(env, "RATE_BAD_TOKEN", 20, 1),
      windowS: int(env, "RATE_WINDOW_S", 60, 1),
    },
  };
}
