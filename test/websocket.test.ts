/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptUpgrade, encodeFrame, MAX_MESSAGE, refuseUpgrade, webSocketKey, WsConnection } from "../src/websocket.js";
import { clientFrame, FakeSocket } from "./fakes.js";

afterEach(() => vi.useRealTimers());

function open() {
  const sock = new FakeSocket();
  const texts: string[] = [];
  let closed = 0;
  const ws = new WsConnection(sock as unknown as Socket, (t) => texts.push(t), () => closed++);
  return { sock, ws, texts, closed: () => closed };
}

const closeCode = (s: FakeSocket) => s.frames().find((f) => f.opcode === 8)?.payload.readUInt16BE(0);

describe("handshake helpers", () => {
  it("accepts only a GET upgrade with a sane key", () => {
    const req = (o: object) => ({ method: "GET", headers: { upgrade: "WebSocket", "sec-websocket-key": "abc" }, ...o }) as never;
    expect(webSocketKey(req({}))).toBe("abc");
    expect(webSocketKey(req({ method: "POST" }))).toBeNull();
    expect(webSocketKey(req({ headers: { upgrade: "h2c", "sec-websocket-key": "abc" } }))).toBeNull();
    expect(webSocketKey(req({ headers: { upgrade: "websocket" } }))).toBeNull();
    expect(webSocketKey(req({ headers: { upgrade: "websocket", "sec-websocket-key": "x".repeat(65) } }))).toBeNull();
  });

  it("answers 101 with the RFC 6455 accept value and refuses with a closing reply", () => {
    const s = new FakeSocket();
    acceptUpgrade(s as never, "dGhlIHNhbXBsZSBub25jZQ==");
    expect(s.text()).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const r = new FakeSocket();
    refuseUpgrade(r as never, "404 Not Found");
    expect(r.text()).toContain("404 Not Found");
    expect(r.destroyed).toBe(true);
  });

  it("encodes the three length forms", () => {
    expect(encodeFrame(1, Buffer.alloc(5)).length).toBe(7);
    expect(encodeFrame(1, Buffer.alloc(300)).length).toBe(304);
    expect(encodeFrame(1, Buffer.alloc(70000)).length).toBe(70010);
  });
});

describe("WebSocket connection", () => {
  it("delivers text messages of every length form, also split over chunks and several per chunk", () => {
    const { sock, texts } = open();
    const long = "x".repeat(300);
    const huge = "y".repeat(70000);
    sock.emit("data", Buffer.concat([clientFrame("a"), clientFrame(long)]));
    const big = clientFrame(huge);
    sock.emit("data", big.subarray(0, 1));
    sock.emit("data", big.subarray(1, 3));
    sock.emit("data", big.subarray(3, 9));
    sock.emit("data", big.subarray(9, 11));
    sock.emit("data", big.subarray(11, 500));
    sock.emit("data", big.subarray(500));
    expect(texts).toEqual(["a", long, huge]);
    const m = clientFrame(long);
    sock.emit("data", m.subarray(0, 3));
    sock.emit("data", m.subarray(3));
    expect(texts[3]).toBe(long);
  });

  it("reassembles fragments", () => {
    const { sock, texts } = open();
    sock.emit("data", Buffer.concat([clientFrame("he", 0x1, false), clientFrame("l", 0x0, false), clientFrame("lo", 0x0, true)]));
    expect(texts).toEqual(["hello"]);
  });

  it("answers ping with pong, reports pong, and closes on a close frame", () => {
    const { sock, ws, closed } = open();
    let pongs = 0;
    sock.emit("data", clientFrame("", 0xa)); // no handler yet
    ws.onPong = () => pongs++;
    sock.emit("data", Buffer.concat([clientFrame("p", 0x9), clientFrame("", 0xa)]));
    expect(sock.frames().find((f) => f.opcode === 0xa)?.payload.toString()).toBe("p");
    expect(pongs).toBe(1);
    sock.emit("data", clientFrame(Buffer.from([3, 232]), 0x8));
    expect(closeCode(sock)).toBe(1000);
    expect(closed()).toBe(1);
    expect(ws.closed).toBe(true);
  });

  it.each([
    ["an unmasked frame", Buffer.from([0x81, 0x01, 0x61]), 1002],
    ["reserved bits", clientFrame("a", 0x1, true, 0x40), 1002],
    ["a fragmented control frame", clientFrame("a", 0x9, false), 1002],
    ["an oversized control frame", clientFrame("x".repeat(126), 0x9), 1002],
    ["a binary frame", clientFrame("a", 0x2), 1003],
    ["a continuation without a start", clientFrame("a", 0x0), 1002],
    ["a new message inside a fragmented one", Buffer.concat([clientFrame("a", 0x1, false), clientFrame("b")]), 1002],
    ["a declared length beyond the limit", Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0xff, 0, 0, 0, 1, 2, 3, 4]), 1009],
  ])("closes on %s", (_n, frame, code) => {
    const { sock, closed } = open();
    sock.emit("data", frame);
    expect(closeCode(sock)).toBe(code);
    expect(closed()).toBe(1);
  });

  it("closes when fragments add up beyond the limit", () => {
    const { sock } = open();
    const piece = "z".repeat(Math.floor(MAX_MESSAGE * 0.6));
    sock.emit("data", clientFrame(piece, 0x1, false));
    sock.emit("data", clientFrame(piece, 0x0, false));
    expect(closeCode(sock)).toBe(1009);
  });

  it("stops reading after a handler closed the connection, and ignores data once closed", () => {
    const sock = new FakeSocket();
    const seen: string[] = [];
    const ws: WsConnection = new WsConnection(sock as never, (t) => { seen.push(t); ws.close(); }, () => {});
    sock.emit("data", Buffer.concat([clientFrame("one"), clientFrame("two")]));
    sock.emit("data", clientFrame("three"));
    expect(seen).toEqual(["one"]);
  });

  it("sends, pings and closes only while open", () => {
    vi.useFakeTimers();
    const { sock, ws } = open();
    let done = 0;
    expect(ws.send("hi", () => done++)).toBe(true);
    ws.ping();
    expect(done).toBe(1);
    expect(sock.frames().map((f) => f.opcode)).toEqual([1, 9]);
    ws.close(1001);
    ws.close(1001);
    expect(sock.destroyed).toBe(true);
    expect(ws.send("late")).toBe(false);
    const before = sock.written.length;
    ws.ping();
    expect(sock.written.length).toBe(before);
    vi.advanceTimersByTime(2500); // the fallback destroy timer
  });

  it("does not send on a destroyed socket and survives socket errors", () => {
    const { sock, ws, closed } = open();
    sock.destroyed = true;
    expect(ws.send("x")).toBe(false);
    sock.destroyed = false;
    sock.emit("error", new Error("boom")); // destroys, which emits close
    expect(sock.destroyed).toBe(true);
    expect(closed()).toBe(1);
  });
});
