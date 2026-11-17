/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EventStream, SseParser } from "../src/events.js";
import { Metrics } from "../src/metrics.js";
import { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";
import { createWebhookServer, sign, verify } from "../src/webhook.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const wait = async (cond: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("condition not met in time");
};

const BODY = '{"type":"device.revoked","epoch":"a1b2c3d4","seq":1,"time":1700000000,"deviceId":"d1","player":"p1"}';

describe("signature", () => {
  it("matches the test vector the plugin asserts too (WebhookDispatcher.sign)", () => {
    expect(sign("0123456789abcdef-secret", 1700000000, Buffer.from(BODY)))
      .toBe("sha256=3c3de4487ff7c14502e2546a8887a60bf3c93e72e75887eb89aff022e1eb4a11");
  });
  it("rejects tampering, a wrong secret and old timestamps", () => {
    const secret = "0123456789abcdef-secret";
    const now = 1700000100_000;
    const good = sign(secret, 1700000000, Buffer.from(BODY));
    expect(verify(secret, "1700000000", good, Buffer.from(BODY), 300, now)).toBeNull();
    expect(verify(secret, "1700000000", good, Buffer.from(BODY.replace("d1", "d2")), 300, now)).toBe("bad signature");
    expect(verify("another-secret-value", "1700000000", good, Buffer.from(BODY), 300, now)).toBe("bad signature");
    expect(verify(secret, "1700000000", good, Buffer.from(BODY), 300, now + 400_000)).toBe("timestamp outside tolerance");
    expect(verify(secret, "1700000000", undefined, Buffer.from(BODY), 300, now)).toBe("bad signature");
    expect(verify(secret, undefined, good, Buffer.from(BODY), 300, now)).toBe("missing timestamp");
  });
});

describe("SSE parser", () => {
  it("handles split chunks, CRLF, comments and multi-line data", () => {
    const p = new SseParser();
    expect(p.feed(": connected\r\n\r\nid: a:1\nevent: device.rev")).toEqual([]);
    expect(p.feed("oked\ndata: {\"x\":\n")).toEqual([]);
    expect(p.feed("data: 1}\n\n")).toEqual([{ id: "a:1", event: "device.revoked", data: '{"x":\n1}' }]);
    expect(p.feed("event: reset\ndata: {}\r")).toEqual([]);
    expect(p.feed("\n\r\n")).toEqual([{ id: "a:1", event: "reset", data: "{}" }]);
  });
});

describe("webhook receiver", () => {
  async function start() {
    const store = new MemoryStore();
    const revocations = new Revocations(store, 3600);
    const server = createWebhookServer("0123456789abcdef-secret", 300, revocations, new Metrics());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    const post = (body: string, headers: Record<string, string>, path = "/hooks/mcdashboard") => new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, method: "POST", headers: { "content-length": Buffer.byteLength(body), ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end(body);
    });
    const signed = (body: string, ts = Math.floor(Date.now() / 1000)) => ({ "x-mcdashboard-timestamp": String(ts), "x-mcdashboard-signature": sign("0123456789abcdef-secret", ts, Buffer.from(body)) });
    return { revocations, post, signed };
  }

  it("records a signed revocation", async () => {
    const { revocations, post, signed } = await start();
    expect(await post(BODY, signed(BODY))).toBe(204);
    expect(await revocations.isDenied("d1")).toBe(true);
    expect(await revocations.isDenied("d2")).toBe(false);
  });

  it("refuses unsigned, tampered, replayed-late and misrouted requests without recording anything", async () => {
    const { revocations, post, signed } = await start();
    expect(await post(BODY, {})).toBe(401);
    expect(await post(BODY.replace("d1", "d9"), signed(BODY))).toBe(401);
    expect(await post(BODY, signed(BODY, Math.floor(Date.now() / 1000) - 3600))).toBe(401);
    expect(await post(BODY, signed(BODY), "/other")).toBe(404);
    expect(await revocations.isDenied("d1")).toBe(false);
    expect(await revocations.isDenied("d9")).toBe(false);
  });

  it("acknowledges event types it does not know, so the plugin does not retry them", async () => {
    const { revocations, post, signed } = await start();
    const other = '{"type":"device.paired","deviceId":"d5"}';
    expect(await post(other, signed(other))).toBe(204);
    expect(await revocations.isDenied("d5")).toBe(false);
  });
});

describe("event stream", () => {
  /** A stand-in for the plugin's GET /v1/events. */
  async function fakePlugin() {
    const state = { sockets: [] as ServerResponse[], requests: [] as IncomingHttpHeaders[], status: 200 };
    const server = createServer((req, res) => {
      state.requests.push(req.headers);
      if (req.headers.authorization !== "Bearer events-token-0123456789") { res.writeHead(401).end(); return; }
      if (state.status !== 200) { res.writeHead(state.status).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write("retry: 3000\n: connected\n\n");
      state.sockets.push(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    const send = (id: string, event: string, data: object) => state.sockets.forEach((s) => s.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    return { state, send, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) };
  }
  const revoked = (seq: number, deviceId: string) => ({ type: "device.revoked", epoch: "e1", seq, time: 1, deviceId, player: "p" });

  it("denies revoked devices, reconnects with the last id, and flushes per-player cache on reset", async () => {
    const plugin = await fakePlugin();
    const revocations = new Revocations(new MemoryStore(), 3600);
    const stream = new EventStream({ url: plugin.url, token: "events-token-0123456789", revocations, metrics: new Metrics() });
    closers.push(() => stream.stop());
    stream.start();
    await wait(() => stream.connected);
    await new Promise((r) => setTimeout(r, 50));
    const afterConnect = await revocations.generation();
    plugin.send("e1:1", "device.revoked", revoked(1, "dev-a"));
    await wait(() => revocations.isDenied("dev-a"));
    expect(await revocations.isDenied("dev-b")).toBe(false);

    plugin.state.sockets.splice(0).forEach((s) => s.destroy());
    await wait(() => plugin.state.requests.length >= 2 && stream.connected, 6000);
    expect(plugin.state.requests.at(-1)!["last-event-id"]).toBe("e1:1");
    plugin.send("e1:2", "device.revoked", revoked(2, "dev-b"));
    await wait(() => revocations.isDenied("dev-b"));
    expect(await revocations.generation()).toBe(afterConnect);

    plugin.send("e1:3", "reset", { epoch: "e2" });
    await new Promise((r) => setTimeout(r, 2200)); // the generation is memoised for 2 s
    await wait(async () => (await revocations.generation()) !== afterConnect, 4000);
  });

  it("keeps retrying when the token is wrong or events are off, without denying anything", async () => {
    const plugin = await fakePlugin();
    const logs: string[] = [];
    const revocations = new Revocations(new MemoryStore(), 3600);
    const stream = new EventStream({ url: plugin.url, token: "wrong-token-0123456789", revocations, metrics: new Metrics(), log: (m) => logs.push(m) });
    closers.push(() => stream.stop());
    stream.start();
    await wait(() => logs.length > 0);
    expect(stream.connected).toBe(false);
    expect(logs[0]).toContain("401");
  });
});
