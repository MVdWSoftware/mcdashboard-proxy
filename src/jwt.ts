/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenCheck = { ok: true; deviceId: string; player: string; expiresAt: number } | { ok: false; reason: string };

/**
 * Edge check of the plugin's access tokens (RFC 7519, HS256). Only an HS256 header is accepted,
 * so `alg: none` and algorithm confusion are rejected. Revocation stays the plugin's job.
 */
export function verifyAccessToken(token: string, secret: Buffer, nowMs = Date.now()): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 2048) return { ok: false, reason: "malformed token" };
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "HS256") return { ok: false, reason: "unsupported algorithm" };
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const given = Buffer.from(s, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad signature" };
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    if (claims.typ !== "access") return { ok: false, reason: "not an access token" };
    const exp = typeof claims.exp === "number" ? claims.exp * 1000 : Infinity;
    if (exp < nowMs) return { ok: false, reason: "token expired" };
    return { ok: true, deviceId: String(claims.sub ?? ""), player: String(claims.player ?? ""), expiresAt: exp };
  } catch {
    return { ok: false, reason: "malformed token" };
  }
}

export function bearer(header: string | undefined): string | null {
  const m = header ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
  return m ? m[1]! : null;
}

/**
 * The `sub` (device id) of a token WITHOUT verifying it. Only for looking a token up on the revocation list
 * when the proxy has no secret: a forged `sub` can only get a request refused, never accepted.
 */
export function peekDeviceId(token: string): string | null {
  const p = token.split(".")[1];
  if (!p || token.length > 2048) return null;
  try {
    const sub = (JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>).sub;
    return typeof sub === "string" && sub.length > 0 && sub.length <= 128 ? sub : null;
  } catch {
    return null;
  }
}
