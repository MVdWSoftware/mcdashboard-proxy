/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import type { ScopeKind } from "./cache.js";
import { bearer, peekDeviceId, verifyAccessToken } from "./jwt.js";
import type { RateLimiter } from "./ratelimit.js";
import { HttpError } from "./respond.js";
import type { Revocations } from "./revocations.js";

/** A cache scope: `key` is part of the cache key, "" for anonymous requests. */
export interface Scope {
  key: string;
  kind: ScopeKind;
}

export const ANONYMOUS: Scope = { key: "", kind: "anonymous" };

/**
 * The scope an answer is stored under. A typed player name (`security.allow-player-names`) identifies the caller as a
 * token does: the plugin then computes `private` answers for a request without `Authorization`, per player. Without
 * this, such answers would be refused as "private for an anonymous client" and caching would be off on those servers.
 */
export function withPlayer(scope: Scope, player: string): Scope {
  return scope.kind === "anonymous" && player !== "" ? { key: `n:${player}`, kind: "player" } : scope;
}

const INVALID_TOKEN = { "www-authenticate": 'Bearer error="invalid_token"' };

/**
 * Who is asking, as a cache scope. With the secret the token is verified and the scope is the player, so a player's
 * devices share entries; without it the scope is a hash of the token (never shared with anyone else). Invalid tokens
 * are refused and throttled per client.
 */
export class Scopes {
  constructor(
    private readonly secret: Buffer | null,
    private readonly revocations: Revocations,
    private readonly limiter: RateLimiter,
    private readonly badTokenLimit: number,
  ) {}

  async of(authorization: string, client: string): Promise<Scope> {
    const token = bearer(authorization);
    if (token === null) return this.refuse(client, "invalid authorization header");
    const claims = this.secret ? verifyAccessToken(token, this.secret) : null;
    if (claims && !claims.ok) return this.refuse(client, claims.reason);
    // Checked before any cache lookup: the player's other devices share the scope and must keep working, so the
    // entries cannot simply be dropped.
    const device = claims ? claims.deviceId : peekDeviceId(token);
    if (device && (await this.revocations.isDenied(device))) throw new HttpError(401, "device revoked", INVALID_TOKEN, "revoked");
    if (claims?.player) return { key: "p:" + claims.player, kind: "player" };
    return { key: "t:" + createHash("sha256").update(token).digest("base64url"), kind: claims ? "token" : "unverified" };
  }

  private async refuse(client: string, reason: string): Promise<never> {
    const rl = await this.limiter.hit("badtoken", client, this.badTokenLimit);
    if (!rl.allowed) throw new HttpError(429, "too many invalid tokens", { "retry-after": String(rl.retryAfterS) }, "bad_token");
    throw new HttpError(401, reason, INVALID_TOKEN, "bad_token");
  }
}
