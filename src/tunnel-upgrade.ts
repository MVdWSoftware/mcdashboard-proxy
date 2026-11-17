/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { AddressList, bucket } from "./clientip.js";
import type { ClientIp } from "./clientip.js";
import type { Config } from "./config.js";
import type { Metrics } from "./metrics.js";
import type { RateLimiter } from "./ratelimit.js";
import type { TunnelHub } from "./tunnel.js";
import { acceptUpgrade, refuseUpgrade, webSocketKey } from "./websocket.js";
import type { UpgradeHandler } from "./websocket.js";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * Accepts the plugin's connection on `config.tunnelPath`. Checks, in this order: handshake shape, the allowed addresses
 * (anything else gets a plain 404, so the endpoint is not revealed), a rate limit on attempts per client, and the API
 * key in `Authorization: Bearer` (constant-time comparison of digests). Only then is the socket upgraded.
 */
export function tunnelUpgrade(config: Config, hub: TunnelHub, limiter: RateLimiter, clients: ClientIp, metrics: Metrics): UpgradeHandler {
  const allowed = new AddressList(config.tunnelAllowedIps, "TUNNEL_ALLOWED_IPS");
  const expected = digest(config.tunnelToken ?? "");
  return (req, socket, head) => {
    const ip = clients.of(req);
    const key = webSocketKey(req);
    if (!key) return refuseUpgrade(socket, "404 Not Found");
    if (!allowed.empty && !allowed.has(ip)) {
      metrics.inc("mcdp_tunnel_rejected_total", { reason: "address" });
      return refuseUpgrade(socket, "404 Not Found");
    }
    limiter.hit("tunnel", bucket(ip), config.limits.auth).then((rl) => {
      if (!rl.allowed) {
        metrics.inc("mcdp_tunnel_rejected_total", { reason: "rate_limit" });
        return refuseUpgrade(socket, "429 Too Many Requests", `Retry-After: ${rl.retryAfterS}\r\n`);
      }
      const h = req.headers.authorization ?? "";
      if (!timingSafeEqual(digest(h.startsWith("Bearer ") ? h.slice(7).trim() : ""), expected)) {
        metrics.inc("mcdp_tunnel_rejected_total", { reason: "key" });
        return refuseUpgrade(socket, "401 Unauthorized", "WWW-Authenticate: Bearer\r\n");
      }
      acceptUpgrade(socket, key);
      hub.adopt(socket as Socket, head);
    }).catch(() => refuseUpgrade(socket, "503 Service Unavailable"));
  };
}
