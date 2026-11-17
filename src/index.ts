#!/usr/bin/env node
/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { EventStream } from "./events.js";
import { createProxy } from "./proxy.js";
import { Revocations } from "./revocations.js";
import { FallbackStore, MemoryStore, RedisStore } from "./store.js";
import type { Store } from "./store.js";
import { createWebhookServer } from "./webhook.js";

const config = loadConfig();
let store: Store;
let fallbacks = 0;
if (config.redisUrl) {
  const fb = new FallbackStore(new RedisStore(config.redisUrl, config.keyPrefix));
  fb.onFallback = () => void fallbacks++;
  store = fb;
} else {
  console.warn("REDIS_URL is not set: cache and rate limits are per process (fine for one node, not for several)");
  store = new MemoryStore();
}

const revocations = new Revocations(store, config.revocationTtlS);
const proxy = createProxy(config, store, revocations);
const target = config.tunnelToken ? `tunnel ${config.tunnelPath} (waiting for the plugin)` : config.upstream.origin;
proxy.server.listen(config.listenPort, config.listenHost, () => console.log(`mcdashboard-proxy on ${config.listenHost}:${config.listenPort} -> ${target}`));

// The stream resumes by itself; webhooks cannot, so a start with webhooks only drops per-player entries instead.
const stream = config.eventsToken && !config.tunnelToken
  ? new EventStream({ url: config.upstream, token: config.eventsToken, revocations, metrics: proxy.metrics, log: (m) => console.warn(m) })
  : null;
stream?.start();
let webhook: Server | null = null;
if (config.webhookSecret && config.webhookPort > 0) {
  webhook = createWebhookServer(config.webhookSecret, config.webhookToleranceS, revocations, proxy.metrics);
  webhook.listen(config.webhookPort, config.webhookHost, () => console.log(`webhook receiver on ${config.webhookHost}:${config.webhookPort}`));
  if (!stream) void revocations.bumpGeneration();
}
if (!stream && !webhook && !config.tunnelToken) console.warn("No revocation feed (EVENTS_TOKEN / WEBHOOK_*): a revoked device may be served from cache for up to one placeholder interval");

function tunnelGauges(): Record<string, number> {
  const t = proxy.tunnel?.info();
  if (!t) return {};
  return {
    mcdp_tunnel_connected: t.connected ? 1 : 0,
    mcdp_tunnel_uptime_seconds: t.connected && t.since ? Math.floor((Date.now() - t.since) / 1000) : 0,
    mcdp_tunnel_silent_seconds: t.silentMs === undefined ? 0 : Math.floor(t.silentMs / 1000),
    mcdp_tunnel_rtt_ms: t.rttMs ?? 0,
    mcdp_tunnel_inflight: t.inflight,
    mcdp_tunnel_channels: t.channels,
  };
}

// Operational endpoints: on their own port (loopback by default), never on the public one.
const admin = createServer(async (req, res) => {
  if (req.url === "/healthz") return void res.writeHead(200).end("ok\n");
  if (req.url === "/tunnelz" && proxy.tunnel) {
    const t = proxy.tunnel.info();
    return void res.writeHead(t.connected ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(t));
  }
  if (req.url === "/readyz") return void res.writeHead((await proxy.ready()) ? 200 : 503).end();
  if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    return void res.end(proxy.metrics.render({ mcdp_store_fallback_total: fallbacks, mcdp_redis_up: (await store.ping()) ? 1 : 0, mcdp_events_connected: stream?.connected ? 1 : 0, ...tunnelGauges() }));
  }
  res.writeHead(404).end();
});
if (config.adminPort > 0) admin.listen(config.adminPort, config.adminHost);

const shutdown = () => {
  stream?.stop();
  webhook?.close();
  admin.close();
  proxy.close().then(() => store.close()).finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
