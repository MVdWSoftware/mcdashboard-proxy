/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";
import { get, startProxy } from "./helpers.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const KEY = "k".repeat(40);

function maskedFrame(text: string, opcode = 0x1, fin = true): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const b0 = (fin ? 0x80 : 0) | opcode;
  const n = payload.length;
  let head: Buffer;
  if (n < 126) head = Buffer.from([b0, 0x80 | n]);
  else if (n < 65536) head = Buffer.from([b0, 0x80 | 126, n >> 8, n & 255]);
  else {
    head = Buffer.from([b0, 0x80 | 127, 0, 0, 0, 0, 0, 0, 0, 0]);
    head.writeUInt32BE(n, 6);
  }
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
}

/** A stand-in plugin: dials the proxy's tunnel and answers with whatever `onMessage` returns. */
async function plugin(port: number, opts: { key?: string; onMessage?: (m: any, send: (o: unknown) => void) => void } = {}) {
  const sock = connect(port, "127.0.0.1");
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(`GET /tunnel HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${opts.key ?? KEY}\r\n\r\n`);
  closers.push(() => sock.destroy());
  let buf = Buffer.alloc(0);
  let head: string | null = null;
  const messages: any[] = [];
  const send = (o: unknown) => sock.write(maskedFrame(JSON.stringify(o)));
  const first = new Promise<string>((resolve) => {
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (head === null) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4);
        resolve(head);
      }
      while (buf.length >= 2) {
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        if ((buf[0]! & 0x0f) === 1) {
          const m = JSON.parse(buf.subarray(off, off + len).toString());
          messages.push(m);
          opts.onMessage?.(m, send);
        }
        buf = buf.subarray(off + len);
      }
    });
  });
  return { head: await first, send, messages, sock };
}

const answer = (m: any, send: (o: unknown) => void) => {
  if (m.t === "req") send({ t: "res", id: m.id, s: 200, h: { "content-type": "application/senml+json", "cache-control": "public, max-age=2", server: "secret" }, b: Buffer.from('[{"n":"online","v":1}]').toString("base64") });
};

describe("reverse tunnel", () => {
  it("serves REST over the one tunnel connection and never opens its own upstream", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY });
    closers.push(p.close);
    const t = await plugin(p.port, { onMessage: answer });
    expect(t.head).toContain("101");
    t.send({ t: "hello", server: "test", version: "1" });
    await new Promise((r) => setTimeout(r, 50));
    const r = await get(p.port, "/v1/values?ids=online");
    expect(r.status).toBe(200);
    expect(r.body).toContain("online");
    expect(r.headers.server).toBeUndefined();
    expect(t.messages.filter((m) => m.t === "req")).toHaveLength(1);
  });

  it("answers 502 while the plugin is not connected", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY });
    closers.push(p.close);
    expect((await get(p.port, "/v1/values?ids=online")).status).toBe(502);
  });

  it("refuses a wrong key, a wrong address, and rate limits attempts", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY, RATE_AUTH: "3" });
    closers.push(p.close);
    expect((await plugin(p.port, { key: "x".repeat(40) })).head).toContain("401");
    const q = await startProxy({ TUNNEL_TOKEN: KEY, TUNNEL_ALLOWED_IPS: "10.9.9.9" });
    closers.push(q.close);
    expect((await plugin(q.port)).head).toContain("404");
    await plugin(p.port, { key: "y".repeat(40) });
    await plugin(p.port, { key: "y".repeat(40) });
    expect((await plugin(p.port, { key: "y".repeat(40) })).head).toContain("429");
  });

  it("applies revocations sent over the tunnel", async () => {
    const store = new MemoryStore();
    const rev = new Revocations(store, 3600);
    const p = await startProxy({ TUNNEL_TOKEN: KEY }, store, rev);
    closers.push(p.close);
    const t = await plugin(p.port);
    t.send({ t: "hello" });
    t.send({ t: "ev", id: "e:1", e: { type: "device.revoked", epoch: "e", seq: 1, time: 1, deviceId: "dev1", player: "p" } });
    await new Promise((r) => setTimeout(r, 80));
    expect(await rev.isDenied("dev1")).toBe(true);
  });

  it("carries live-feed bytes both ways", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY });
    closers.push(p.close);
    const t = await plugin(p.port, {
      onMessage: (m, send) => {
        if (m.t === "d") send({ t: "d", c: m.c, b: m.b });
      },
    });
    t.send({ t: "hello" });
    await new Promise((r) => setTimeout(r, 50));
    const app = connect(p.port, "127.0.0.1");
    closers.push(() => app.destroy());
    await new Promise<void>((r) => app.once("connect", () => r()));
    app.write("GET /v1/live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const echoed = await new Promise<string>((r) => app.once("data", (d) => r(d.toString())));
    expect(echoed).toContain("GET /v1/live");
    expect(t.messages.some((m) => m.t === "open")).toBe(true);
  });

  it("drops a plugin that goes silent and recovers when it reconnects", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY, TUNNEL_DEAD_S: "3" });
    closers.push(p.close);
    const t = await plugin(p.port);
    t.send({ t: "hello", server: "s" });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.proxy.tunnel!.connected).toBe(true);
    expect(p.proxy.tunnel!.info().silentMs).toBeLessThan(2000);
    await new Promise<void>((r) => t.sock.once("close", () => r()));
    expect(p.proxy.tunnel!.connected).toBe(false);
    expect((await get(p.port, "/v1/values?ids=online")).status).toBe(502);
    const again = await plugin(p.port, { onMessage: answer });
    again.send({ t: "hello", server: "s" });
    await new Promise((r) => setTimeout(r, 100));
    expect((await get(p.port, "/v1/values?ids=online")).status).toBe(200);
  }, 15_000);

  it("closes a socket that never says hello, and does not route requests to it", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY, TUNNEL_DEAD_S: "3" });
    closers.push(p.close);
    const t = await plugin(p.port);
    expect(p.proxy.tunnel!.connected).toBe(false);
    await new Promise<void>((r) => t.sock.once("close", () => r()));
  }, 10_000);

  it("a new connection replaces the old one", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY });
    closers.push(p.close);
    const a = await plugin(p.port);
    a.send({ t: "hello" });
    await new Promise((r) => setTimeout(r, 50));
    const b = await plugin(p.port, { onMessage: answer });
    b.send({ t: "hello" });
    await new Promise<void>((r) => a.sock.once("close", () => r()));
    await new Promise((r) => setTimeout(r, 50));
    expect((await get(p.port, "/v1/values?ids=online")).status).toBe(200);
  });

  it("carries a large response split over many TCP writes", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY });
    closers.push(p.close);
    const body = Buffer.alloc(100_000, "a").toString("base64");
    const t = await plugin(p.port, {
      onMessage: (m) => {
        if (m.t !== "req") return;
        const frame = maskedFrame(JSON.stringify({ t: "res", id: m.id, s: 200, h: { "content-type": "text/plain" }, b: body }));
        for (let i = 0; i < frame.length; i += 1000) t.sock.write(frame.subarray(i, i + 1000));
      },
    });
    t.send({ t: "hello" });
    await new Promise((r) => setTimeout(r, 50));
    const r = await get(p.port, "/v1/info");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(100_000);
  });

  it.each([
    ["a fragmented ping", maskedFrame("", 0x9, false)],
    ["a continuation without a message", maskedFrame("{}", 0x0)],
    ["a new message inside a fragmented one", Buffer.concat([maskedFrame("{", 0x1, false), maskedFrame("{}", 0x1)])],
    ["an unmasked frame", Buffer.from([0x81, 0x02, 0x7b, 0x7d])],
  ])("closes the tunnel on a protocol violation: %s", async (_name, bytes) => {
    const p = await startProxy({ TUNNEL_TOKEN: KEY });
    closers.push(p.close);
    const t = await plugin(p.port);
    t.send({ t: "hello" });
    await new Promise((r) => setTimeout(r, 50));
    expect(p.proxy.tunnel!.connected).toBe(true);
    const closed = new Promise<void>((r) => t.sock.once("close", () => r()));
    t.sock.write(bytes);
    await closed;
    expect(p.proxy.tunnel!.connected).toBe(false);
  });
});
