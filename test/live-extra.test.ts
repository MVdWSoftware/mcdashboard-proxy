/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { connect, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../src/store.js";
import { MemoryStore } from "../src/store.js";
import { startProxy } from "./helpers.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const REQ = (extra = "") => `GET /v1/live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;

function dial(port: number, data: string) {
  return new Promise<{ head: string; sock: Socket }>((resolve) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(data));
    sock.once("data", (d) => resolve({ head: d.toString(), sock }));
    sock.once("close", () => resolve({ head: "", sock }));
    sock.on("error", () => {});
    closers.push(() => sock.destroy());
  });
}

describe("live relay", () => {
  it("rate limits handshakes per client", async () => {
    const p = await startProxy({ RATE_READ: "1" });
    closers.push(p.close);
    await dial(p.port, REQ());
    expect((await dial(p.port, REQ())).head).toContain("429");
  });

  it("answers 503 for a tunnel that is not connected", async () => {
    const p = await startProxy({ TUNNEL_TOKEN: "k".repeat(40) });
    closers.push(p.close);
    expect((await dial(p.port, REQ())).head).toContain("503");
  });

  it("answers 503 when the limiter fails", async () => {
    const broken: Store = { get: async () => null, set: async () => {}, hit: () => Promise.reject(new Error("x")), ping: async () => true, close: async () => {} };
    const p = await startProxy({}, broken);
    closers.push(p.close);
    expect((await dial(p.port, REQ())).head).toContain("503");
  });

  it("refuses when the total connection cap is reached", async () => {
    const server = createServer((s) => s.once("data", () => s.write("HTTP/1.1 101 x\r\n\r\n")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.close());
    const p = await startProxy({ UPSTREAM_LIVE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, MAX_LIVE_TOTAL: "1" }, new MemoryStore());
    closers.push(p.close);
    await dial(p.port, REQ());
    expect((await dial(p.port, REQ())).head).toContain("429");
  });

  it("forwards subprotocols, early bytes and survives a TLS upstream that is not there", async () => {
    const seen: string[] = [];
    const server = createServer((s) => s.on("data", (d) => { seen.push(d.toString()); s.write("HTTP/1.1 101 x\r\n\r\n"); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.close());
    const p = await startProxy({ UPSTREAM_LIVE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    closers.push(p.close);
    const { sock } = await dial(p.port, REQ("Sec-WebSocket-Protocol: a, b\r\nSec-WebSocket-Version: 13\r\n") + "early");
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.join("")).toContain("Sec-WebSocket-Protocol: a, b");
    expect(seen.join("")).toContain("early");
    sock.destroy();

    const t = await startProxy({ UPSTREAM_LIVE_URL: "https://127.0.0.1:1" });
    closers.push(t.close);
    const sock2 = connect(t.port, "127.0.0.1", () => sock2.write(REQ()));
    sock2.on("error", () => {});
    await new Promise((r) => sock2.once("close", r));
  });
});
