import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAccessToken } from "../src/jwt.js";

const secret = Buffer.alloc(48, 7);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }, key = secret) {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
const future = Math.floor(Date.now() / 1000) + 600;

describe("edge token check", () => {
  it("accepts a valid access token", () => {
    expect(verifyAccessToken(token({ typ: "access", sub: "d1", exp: future }), secret)).toMatchObject({ ok: true, deviceId: "d1" });
  });
  it("rejects alg none, other algorithms, wrong key, expiry and refresh tokens", () => {
    expect(verifyAccessToken(`${b64({ alg: "none" })}.${b64({ typ: "access", exp: future })}.`, secret).ok).toBe(false);
    expect(verifyAccessToken(token({ typ: "access", exp: future }, { alg: "HS512" }), secret).ok).toBe(false);
    expect(verifyAccessToken(token({ typ: "access", exp: future }, undefined, Buffer.alloc(48, 1)), secret).ok).toBe(false);
    expect(verifyAccessToken(token({ typ: "access", exp: 1 }), secret).ok).toBe(false);
    expect(verifyAccessToken(token({ typ: "refresh", exp: future }), secret).ok).toBe(false);
    expect(verifyAccessToken("not.a.jwt", secret).ok).toBe(false);
    expect(verifyAccessToken("x".repeat(3000), secret).ok).toBe(false);
  });
});
