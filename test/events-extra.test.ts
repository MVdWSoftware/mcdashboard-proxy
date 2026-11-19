/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer, request } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { applyEvent, EventStream, isDeviceRevokedEvent, SseParser } from "../src/events.js";
import { Metrics } from "../src/metrics.js";
import { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import { createWebhookServer, sign, verify } from "../src/webhook.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const wait = async (cond: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("condition not met in time");
};
const SECRET = "0123456789abcdef-secret";
const ev = { type: "device.revoked", epoch: "e", seq: 1, time: 1, deviceId: "d1", player: "p" };

describe("event validation", () => {
  it("accepts only complete device.revoked events", () => {
    expect(isDeviceRevokedEvent(ev)).toBe(true);
    expect(isDeviceRevokedEvent(null)).toBe(false);
    expect(isDeviceRevokedEvent("x")).toBe(false);
    expect(isDeviceRevokedEvent({ ...ev, deviceId: "" })).toBe(false);
    expect(isDeviceRevokedEvent({ ...ev, deviceId: "x".repeat(129) })).toBe(false);
    expect(isDeviceRevokedEvent({ ...ev, seq: "1" })).toBe(false);
    expect(isDeviceRevokedEvent({ ...ev, player: 1 })).toBe(false);
  });
  it("applies an event and reports whether it did", async () => {
    const r = new Revocations(new MemoryStore(), 60);
    expect(await applyEvent(ev, r, new Metrics())).toBe(true);
    expect(await applyEvent({ type: "x" }, r, new Metrics())).toBe(false);
  });
});

describe("SSE parser edge cases", () => {
  it("handles fields without a colon, ids with NUL, unknown fields, event-only messages and oversized lines", () => {
    const p = new SseParser();
    expect(p.feed("data\n\n")).toEqual([{ id: undefined, event: "message", data: "" }]);
    expect(p.feed("id: a\0b\nretry: 5\nevent\n\n")).toEqual([]);
    expect(p.feed("id: ok\nevent: x\n\n")).toEqual([{ id: "ok", event: "x", data: "" }]);
    expect(p.feed("data: a\r")).toEqual([]);
    expect(p.feed("\n\r\n")).toEqual([{ id: "ok", event: "message", data: "a" }]);
    expect(p.feed("x".repeat(70_000))).toEqual([]);
    expect(p.feed("\n\n")).toEqual([]);
  });
});

describe("webhook signature", () => {
  it("rejects a missing or malformed timestamp and a missing signature", () => {
    const body = Buffer.from("{}");
    expect(verify(SECRET, undefined, "x", body, 300)).toBe("missing timestamp");
    expect(verify(SECRET, "12ab", "x", body, 300)).toBe("missing timestamp");
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verify(SECRET, ts, undefined, body, 300)).toBe("bad signature");
    expect(verify(SECRET, ts, sign(SECRET, ts, body), body, 300)).toBeNull();
  });
});

describe("webhook receiver edge cases", () => {
  async function start(store: Store = new MemoryStore()) {
    const server = createWebhookServer(SECRET, 300, new Revocations(store, 3600), new Metrics());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    const port = (server.address() as AddressInfo).port;
    const send = (body: string, method = "POST", headers: Record<string, string> = {}) => new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/hooks/mcdashboard", method, headers: { "content-length": Buffer.byteLength(body), ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", () => resolve(0));
      req.end(body);
    });
    const signed = (body: string) => { const ts = Math.floor(Date.now() / 1000); return { "x-mcdashboard-timestamp": String(ts), "x-mcdashboard-signature": sign(SECRET, ts, Buffer.from(body)) }; };
    return { send, signed };
  }

  it("refuses other methods, invalid JSON and oversized bodies", async () => {
    const { send, signed } = await start();
    expect(await send("", "GET")).toBe(405);
    expect(await send("{nope", "POST", signed("{nope"))).toBe(400);
    expect(await send("x".repeat(9000), "POST", signed("x".repeat(9000)))).toBe(0);
  });

  it("answers 500 when the event cannot be recorded, so the plugin retries", async () => {
    const broken: Store = { ...new MemoryStore(), get: async () => null, set: () => Promise.reject(new Error("down")), hit: async () => 1, ping: async () => true, close: async () => {} };
    const { send, signed } = await start(broken);
    const body = JSON.stringify(ev);
    expect(await send(body, "POST", signed(body))).toBe(500);
  });
});

describe("event stream edge cases", () => {
  async function plugin(handler: (res: ServerResponse) => void) {
    const server = createServer((_req, res) => handler(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  const sse = (res: ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream" });

  it("ignores undecodable data, events without id and unknown events", async () => {
    const url = await plugin((res) => {
      sse(res);
      res.write("data: {nope\n\n");
      res.write(`event: device.revoked\ndata: ${JSON.stringify({ ...ev, deviceId: "noid" })}\n\n`);
      res.write(`id: 7\nevent: other\ndata: {}\n\n`);
    });
    const r = new Revocations(new MemoryStore(), 60);
    const stream = new EventStream({ url, token: "t", revocations: r, metrics: new Metrics() });
    closers.push(() => stream.stop());
    stream.start();
    await wait(() => r.isDenied("noid"));
  });

  it("retries when the answer is not an event stream", async () => {
    const logs: string[] = [];
    const url = await plugin((res) => res.writeHead(200, { "content-type": "text/plain" }).end("hi"));
    const stream = new EventStream({ url, token: "t", revocations: new Revocations(new MemoryStore(), 60), metrics: new Metrics(), log: (m) => logs.push(m) });
    closers.push(() => stream.stop());
    stream.start();
    await wait(() => logs.length > 0);
    expect(stream.connected).toBe(false);
  });

  it("drops a stream that goes silent", async () => {
    const url = await plugin((res) => { sse(res); res.write(": hi\n\n"); });
    const stream = new EventStream({ url, token: "t", revocations: new Revocations(new MemoryStore(), 60), metrics: new Metrics(), idleMs: 100 });
    closers.push(() => stream.stop());
    stream.start();
    const states: boolean[] = [];
    const t = setInterval(() => states.push(stream.connected), 10);
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(t);
    expect(states).toContain(true);
    expect(states).toContain(false);
  });

  it("copes with https endpoints that are not reachable, and with stop before start", async () => {
    const stream = new EventStream({ url: new URL("https://127.0.0.1:1"), token: "t", revocations: new Revocations(new MemoryStore(), 60), metrics: new Metrics() });
    stream.stop();
    const s2 = new EventStream({ url: new URL("https://127.0.0.1:1"), token: "t", revocations: new Revocations(new MemoryStore(), 60), metrics: new Metrics() });
    s2.start();
    await new Promise((r) => setTimeout(r, 100));
    s2.stop();
    await new Promise((r) => setTimeout(r, 50));
  });
});
