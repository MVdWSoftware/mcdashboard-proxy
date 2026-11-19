/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "../src/metrics.js";
import { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";
import { TunnelChannel } from "../src/tunnel-channel.js";
import type { ChannelHost } from "../src/tunnel-channel.js";
import { TunnelHub } from "../src/tunnel.js";
import { clientFrame, FakeSocket } from "./fakes.js";

afterEach(() => vi.useRealTimers());

describe("tunnel channel", () => {
  function channel(sendOk = true) {
    const sent: Record<string, unknown>[] = [];
    const released: [number, boolean][] = [];
    const host: ChannelHost = {
      send: (m, done) => { sent.push(m); if (sendOk) done?.(); return sendOk; },
      release: (id, notify) => { released.push([id, notify]); },
    };
    return { ch: new TunnelChannel(host, 7), sent, released };
  }

  it("splits big writes into pieces and ignores empty ones", async () => {
    const { ch, sent } = channel();
    await new Promise<void>((r) => ch.write(Buffer.alloc(0), () => r()));
    await new Promise<void>((r) => ch.write(Buffer.alloc(100 * 1024), () => r()));
    expect(sent.map((m) => m.t)).toEqual(["d", "d", "d"]);
    expect(sent.every((m) => m.c === 7)).toBe(true);
  });

  it("fails writes when the tunnel is down", async () => {
    const { ch } = channel(false);
    ch.on("error", () => {});
    const err = await new Promise<Error | null | undefined>((r) => ch.write(Buffer.from("x"), (e) => r(e)));
    expect(err?.message).toBe("tunnel down");
  });

  it("receives data, signals remote close and tells the plugin when destroyed locally", async () => {
    const { ch, released } = channel();
    const got: Buffer[] = [];
    ch.on("data", (d: Buffer) => got.push(d));
    ch.receive(Buffer.from("hi"));
    await new Promise((r) => setImmediate(r));
    expect(got[0]?.toString()).toBe("hi");
    ch.remoteClosed();
    await new Promise((r) => setImmediate(r));
    expect(released).toEqual([[7, true]]);
  });

  it("calls the idle callback after the idle time and re-arms on traffic", () => {
    vi.useFakeTimers();
    const { ch } = channel();
    const cb = vi.fn();
    expect(ch.setTimeout(100, cb)).toBe(ch);
    vi.advanceTimersByTime(80);
    ch.receive(Buffer.from("x"));
    vi.advanceTimersByTime(80);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(cb).toHaveBeenCalledTimes(1);
    ch.setTimeout(50); // no callback
    vi.advanceTimersByTime(60);
    ch.destroy();
  });
});

describe("tunnel hub", () => {
  function hub(extra: { timeoutMs?: number; maxChannels?: number } = {}) {
    const store = new MemoryStore();
    const revocations = new Revocations(store, 3600);
    const metrics = new Metrics();
    const logs: string[] = [];
    const h = new TunnelHub(extra.timeoutMs ?? 1000, extra.maxChannels ?? 2, revocations, metrics, (m) => logs.push(m), { pingMs: 1000, deadMs: 3000, helloMs: 1500 });
    return { h, revocations, metrics, logs };
  }
  const connect = (h: TunnelHub, head = Buffer.alloc(0)) => {
    const sock = new FakeSocket();
    h.adopt(sock as unknown as Socket, head);
    return sock;
  };
  const say = (s: FakeSocket, o: unknown) => s.emit("data", clientFrame(JSON.stringify(o)));
  const sentMsgs = (s: FakeSocket) => s.frames().filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString()));
  const ready = (h: TunnelHub, hello: unknown = { t: "hello", server: "srv\u0007", version: "1" }) => {
    const s = connect(h);
    say(s, hello);
    return s;
  };

  it("is down before a hello, and reports status after", async () => {
    const { h, metrics, logs } = hub();
    expect(h.connected).toBe(false);
    expect(h.info()).toMatchObject({ connected: false, inflight: 0, channels: 0, silentMs: undefined });
    expect(h.send({ t: "x" })).toBe(false);
    const s = ready(h);
    expect(h.connected).toBe(true);
    expect(sentMsgs(s)[0]).toEqual({ t: "ready", since: null });
    expect(h.info()).toMatchObject({ connected: true, server: "srv" });
    expect(h.info().silentMs).toBeGreaterThanOrEqual(0);
    expect(metrics.render()).toContain("mcdp_tunnel_connects_total 1");
    expect(logs[0]).toContain("connected (srv 1)");
  });

  it("works without a logger and with the default timing", () => {
    const h = new TunnelHub(1000, 1, new Revocations(new MemoryStore(), 60), new Metrics());
    ready(h);
    expect(h.connected).toBe(true);
    h.close();
  });

  it("logs a missing server name and version", () => {
    const { h, logs } = hub();
    ready(h, { t: "hello" });
    expect(logs[0]).toBe("tunnel: connected (? )");
  });

  it("replays the first bytes that came with the upgrade", () => {
    const { h } = hub();
    const sock = connect(h, clientFrame(JSON.stringify({ t: "hello" })));
    expect(h.connected).toBe(true);
    expect(sock.destroyed).toBe(false);
  });

  it("closes on invalid JSON and on a first message that is not hello", () => {
    const { h } = hub();
    const a = connect(h);
    a.emit("data", clientFrame("{nope"));
    expect(a.frames().find((f) => f.opcode === 8)?.payload.readUInt16BE(0)).toBe(1007);
    const b = connect(h);
    say(b, { t: "req" });
    expect(b.frames().find((f) => f.opcode === 8)?.payload.readUInt16BE(0)).toBe(1008);
  });

  it("round-trips requests and rejects malformed or oversized responses", async () => {
    const { h } = hub();
    const s = ready(h);
    const p1 = h.request("POST", "/v1/x", { connection: "keep-alive", "content-length": "3", a: "b" }, Buffer.from("abc"));
    const p2 = h.request("GET", "/v1/y", {});
    const [r1, r2] = sentMsgs(s).slice(1);
    expect(r1).toMatchObject({ t: "req", m: "POST", p: "/v1/x", h: { a: "b" }, b: Buffer.from("abc").toString("base64") });
    expect(r2.b).toBeUndefined();
    say(s, { t: "res", id: r1.id, s: 201, h: { "Content-Type": "text/plain", n: 5 }, b: Buffer.from("ok").toString("base64") });
    await expect(p1).resolves.toMatchObject({ status: 201, body: Buffer.from("ok") });
    say(s, { t: "res", id: 999, s: 200 }); // unknown id is ignored
    say(s, { t: "res", id: r2.id, s: 42 });
    await expect(p2).rejects.toThrow("bad response");
    const p3 = h.request("GET", "/", {});
    say(s, { t: "res", id: sentMsgs(s).at(-1).id, s: 204, h: "nope" });
    await expect(p3).resolves.toMatchObject({ status: 204, body: Buffer.alloc(0) });
  });

  it("rejects when down, times out, and fails pending requests when the plugin leaves", async () => {
    vi.useFakeTimers();
    const { h } = hub({ timeoutMs: 500 });
    await expect(h.request("GET", "/", {})).rejects.toThrow("tunnel down");
    const s = ready(h);
    const slow = h.request("GET", "/", {});
    const assertion = expect(slow).rejects.toThrow("upstream timeout");
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    const pending = h.request("GET", "/", {});
    const gone = expect(pending).rejects.toThrow("tunnel down");
    s.destroy();
    await gone;
    expect(h.connected).toBe(false);
  });

  it("carries channels: data both ways, remote close, limit, and notifies on release", async () => {
    const { h } = hub({ maxChannels: 2 });
    expect(h.openChannel()).toBeNull();
    const s = ready(h);
    const a = h.openChannel()!;
    const b = h.openChannel()!;
    expect(h.openChannel()).toBeNull();
    expect(h.info().channels).toBe(2);
    const got: string[] = [];
    a.on("data", (d: Buffer) => got.push(d.toString()));
    say(s, { t: "d", c: a.id, b: Buffer.from("hello").toString("base64") });
    say(s, { t: "d", c: 12345, b: "AA==" }); // unknown channel
    say(s, { t: "d", c: a.id, b: 5 }); // not a string
    say(s, { t: "x", c: 12345 });
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual(["hello"]);
    say(s, { t: "x", c: b.id });
    b.on("error", () => {});
    b.destroy();
    a.destroy(); // local close sends x to the plugin
    expect(sentMsgs(s).filter((m) => m.t === "x" && m.c === a.id)).toHaveLength(1);
    h.release(999, true);
    await new Promise((r) => queueMicrotask(r as never));
  });

  it("does not open a channel when the send fails", () => {
    const { h } = hub();
    const s = ready(h);
    vi.spyOn(s, "write").mockReturnValue(true);
    s.destroyed = true;
    expect(h.openChannel()).toBeNull();
  });

  it("applies device events, remembers the last id for resume and clears it on reset", async () => {
    const { h, revocations, metrics } = hub();
    const s = ready(h);
    const ev = { type: "device.revoked", epoch: "e", seq: 1, time: 1, deviceId: "dev1", player: "p" };
    say(s, { t: "ev", id: "e:1", e: ev });
    say(s, { t: "ev", id: "e:2", e: { type: "other" } });
    say(s, { t: "ev", id: 5, e: { ...ev, deviceId: "dev2" } });
    await vi.waitFor(async () => expect(await revocations.isDenied("dev2")).toBe(true));
    expect(await revocations.isDenied("dev1")).toBe(true);
    const s2 = connect(h); // replaces: resume from the last id
    say(s2, { t: "hello" });
    expect(sentMsgs(s2)[0]).toEqual({ t: "ready", since: "e:1" });
    say(s2, { t: "reset" });
    say(s2, { t: "whatever" });
    expect(metrics.render()).toContain("mcdp_events_resets_total 1");
    const s3 = connect(h);
    say(s3, { t: "hello" });
    expect(sentMsgs(s3)[0]).toEqual({ t: "ready", since: null });
  });

  it("logs a replaced connection and ignores the close of the old one", () => {
    const { h, logs } = hub();
    const a = ready(h);
    ready(h);
    expect(logs).toContain("tunnel: replaced by a new connection");
    expect(a.destroyed).toBe(true);
    expect(h.connected).toBe(true);
  });

  it("drops a socket that never says hello", () => {
    vi.useFakeTimers();
    const { h } = hub();
    const s = connect(h);
    vi.advanceTimersByTime(1600);
    expect(s.frames().find((f) => f.opcode === 8)?.payload.readUInt16BE(0)).toBe(1008);
    const t = ready(h);
    vi.advanceTimersByTime(1600); // helloTimer fires but the connection is ready
    expect(t.destroyed).toBe(false);
  });

  it("pings, measures the round trip, and drops a silent plugin", () => {
    vi.useFakeTimers();
    const { h, metrics } = hub();
    const s = ready(h);
    s.emit("data", clientFrame("", 0xa)); // pong before any ping: no rtt
    expect(h.info().rttMs).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(s.frames().some((f) => f.opcode === 9)).toBe(true);
    vi.advanceTimersByTime(40);
    s.emit("data", clientFrame("", 0xa));
    expect(h.info().rttMs).toBeGreaterThanOrEqual(0);
    vi.advanceTimersByTime(4000);
    expect(metrics.render()).toContain("mcdp_tunnel_dead_total");
    expect(s.frames().find((f) => f.opcode === 8)?.payload.readUInt16BE(0)).toBe(1011);
  });

  it("closes the connection on shutdown, with or without one", () => {
    const { h } = hub();
    h.close();
    const s = ready(h);
    h.close();
    expect(s.frames().find((f) => f.opcode === 8)?.payload.readUInt16BE(0)).toBe(1001);
  });
});
