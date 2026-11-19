/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HttpError, readBody, sendJson, sendRaw } from "../src/respond.js";

function res(headersSent = false) {
  const out = { headersSent, status: 0, headers: {} as Record<string, unknown>, body: undefined as unknown };
  return Object.assign(out, {
    writeHead(s: number, h: Record<string, unknown>) { out.status = s; out.headers = h; return out; },
    end(b: unknown) { out.body = b; },
  });
}
const req = (headers: Record<string, string>) => Object.assign(new PassThrough(), { headers });

describe("responses", () => {
  it("sends JSON with security headers, closing after flood statuses", () => {
    const a = res();
    sendJson(a as never, 200, { ok: true });
    expect(a.headers.connection).toBe("keep-alive");
    const b = res();
    sendJson(b as never, 429, { error: "x" }, { "retry-after": "1" });
    expect(b.headers).toMatchObject({ connection: "close", "retry-after": "1", "x-content-type-options": "nosniff" });
    const c = res(true);
    sendJson(c as never, 200, {});
    expect(c.status).toBe(0);
  });

  it("sends raw answers: no body for HEAD and 304, and nothing once headers went out", () => {
    const body = Buffer.from("abc");
    const a = res();
    sendRaw(a as never, 200, { etag: '"a"' }, body, "GET", "hit");
    expect(a.body).toBe(body);
    expect(a.headers).toMatchObject({ "content-length": 3, "cache-status": "mcdashboard-proxy; hit" });
    const h = res();
    sendRaw(h as never, 200, {}, body, "HEAD", "miss");
    expect(h.body).toBeUndefined();
    const n = res();
    sendRaw(n as never, 304, {}, Buffer.alloc(0), "GET", "hit");
    expect(n.headers["content-length"]).toBeUndefined();
    const s = res(true);
    sendRaw(s as never, 200, {}, body, "GET", "hit");
    expect(s.status).toBe(0);
  });

  it("labels errors by status unless told otherwise", () => {
    expect(new HttpError(404, "x").reason).toBe("404");
    expect(new HttpError(429, "x", {}, "rate_limit").reason).toBe("rate_limit");
  });
});

describe("readBody", () => {
  it("reads declared and chunked bodies", async () => {
    const a = req({ "content-length": "3" });
    const p = readBody(a as never, 10);
    a.end("abc");
    expect((await p).toString()).toBe("abc");
    const b = req({ "transfer-encoding": "chunked" });
    const q = readBody(b as never, 10);
    b.end("xy");
    expect((await q).toString()).toBe("xy");
    const c = req({ "content-length": "1" });
    const r = readBody(c as never, 10);
    c.destroy(new Error("boom"));
    await expect(r).rejects.toThrow("boom");
  });

  it("refuses too large, undeclared and overflowing bodies", async () => {
    await expect(readBody(req({ "content-length": "99" }) as never, 10)).rejects.toMatchObject({ status: 413 });
    await expect(readBody(req({}) as never, 10)).rejects.toMatchObject({ status: 411 });
    const s = req({ "transfer-encoding": "chunked" });
    const p = readBody(s as never, 4);
    s.write("12345");
    await expect(p).rejects.toMatchObject({ status: 413 });
  });
});
