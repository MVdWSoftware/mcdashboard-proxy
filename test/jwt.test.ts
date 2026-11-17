/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "../src/jwt.js";
import { jwt } from "./helpers.js";

const secret = Buffer.alloc(48, 7);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const future = Math.floor(Date.now() / 1000) + 600;

describe("edge token check", () => {
  it("accepts a valid access token", () => {
    expect(verifyAccessToken(jwt({ typ: "access", sub: "d1", exp: future }, secret), secret)).toMatchObject({ ok: true, deviceId: "d1" });
  });
  it("rejects alg none, other algorithms, wrong key, expiry and refresh tokens", () => {
    expect(verifyAccessToken(`${b64({ alg: "none" })}.${b64({ typ: "access", exp: future })}.`, secret).ok).toBe(false);
    expect(verifyAccessToken(jwt({ typ: "access", exp: future }, secret, { alg: "HS512" }), secret).ok).toBe(false);
    expect(verifyAccessToken(jwt({ typ: "access", exp: future }, Buffer.alloc(48, 1)), secret).ok).toBe(false);
    expect(verifyAccessToken(jwt({ typ: "access", exp: 1 }, secret), secret).ok).toBe(false);
    expect(verifyAccessToken(jwt({ typ: "refresh", exp: future }, secret), secret).ok).toBe(false);
    expect(verifyAccessToken("not.a.jwt", secret).ok).toBe(false);
    expect(verifyAccessToken("x".repeat(3000), secret).ok).toBe(false);
  });
});
