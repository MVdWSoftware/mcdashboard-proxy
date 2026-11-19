/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearer, peekDeviceId, verifyAccessToken } from "../src/jwt.js";
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
  it("treats a token without exp as non-expiring and missing sub/player as empty", () => {
    expect(verifyAccessToken(jwt({ typ: "access" }, secret), secret)).toMatchObject({ ok: true, deviceId: "", player: "", expiresAt: Infinity });
    expect(verifyAccessToken(jwt({ typ: "access", sub: "d", player: "p", exp: future }, secret), secret)).toMatchObject({ player: "p", expiresAt: future * 1000 });
  });
  it("rejects undecodable parts", () => {
    expect(verifyAccessToken("!!.!!.!!", secret)).toEqual({ ok: false, reason: "malformed token" });
    const body = `${b64({ alg: "HS256" })}.${Buffer.from("not json").toString("base64url")}`;
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(verifyAccessToken(`${body}.${sig}`, secret)).toEqual({ ok: false, reason: "malformed token" });
  });
});

describe("bearer and peekDeviceId", () => {
  it("extracts the bearer token", () => {
    expect(bearer("Bearer abc.def")).toBe("abc.def");
    expect(bearer("Basic abc")).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
  it("reads a sane sub claim without verifying", () => {
    expect(peekDeviceId(jwt({ sub: "dev" }, secret))).toBe("dev");
    expect(peekDeviceId(jwt({ sub: "" }, secret))).toBeNull();
    expect(peekDeviceId(jwt({ sub: "x".repeat(129) }, secret))).toBeNull();
    expect(peekDeviceId(jwt({ sub: 5 }, secret))).toBeNull();
    expect(peekDeviceId("nodots")).toBeNull();
    expect(peekDeviceId("a." + "x".repeat(3000))).toBeNull();
    expect(peekDeviceId("a.!!notjson")).toBeNull();
  });
});
