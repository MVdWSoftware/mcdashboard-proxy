/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const MAX_MESSAGE = 4 * 1024 * 1024;

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The `Sec-WebSocket-Key` of a well-formed upgrade request (GET, `Upgrade: websocket`), or null. */
export function webSocketKey(req: IncomingMessage): string | null {
  const key = req.headers["sec-websocket-key"];
  const ok = req.method === "GET" && String(req.headers.upgrade).toLowerCase() === "websocket" && typeof key === "string" && key.length <= 64;
  return ok ? key : null;
}

export function acceptUpgrade(socket: Duplex, key: string): void {
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
}

/**
 * Answers an upgrade request with a plain status and closes the socket. It is destroyed once written: HTTP server
 * sockets allow half-open connections and no timeout applies after `upgrade`, so a client that never closes its side
 * would otherwise hold the descriptor forever.
 */
export function refuseUpgrade(socket: Duplex, status: string, extra = ""): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`, () => socket.destroy());
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  let head: Buffer;
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65536) {
    head = Buffer.from([0x80 | opcode, 126, 0, 0]);
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Server side of RFC 6455 for text messages only: reads masked client frames, writes unmasked ones. */
export class WsConnection {
  /** Received bytes not parsed yet; joined only once `need` bytes are there, so a large frame is copied once. */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private need = 2;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  closed = false;
  /** When any byte last arrived: the dead-peer watchdog compares it with the clock. */
  lastRx = Date.now();
  onPong: (() => void) | null = null;

  constructor(readonly socket: Socket, private readonly onText: (text: string) => void, private readonly onClose: () => void) {
    socket.on("data", (d: Buffer) => this.feed(d));
    socket.on("close", () => this.finish());
    socket.on("error", () => socket.destroy());
  }

  send(text: string, done?: () => void): boolean {
    if (this.closed || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")), done);
    return true;
  }

  ping(): void {
    if (!this.closed) this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    this.socket.end(encodeFrame(0x8, body), () => this.socket.destroy());
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private wait(buffer: Buffer, need: number): void {
    this.chunks = buffer.length ? [buffer] : [];
    this.buffered = buffer.length;
    this.need = need;
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.lastRx = Date.now();
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered < this.need) return;
    let buffer = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.buffered);
    for (;;) {
      if (buffer.length < 2) return this.wait(buffer, 2);
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      // Clients must mask, no extension is negotiated, control frames are short and never fragmented.
      if ((b1 & 0x80) === 0 || (b0 & 0x70) !== 0) return this.close(1002);
      if (opcode >= 0x8 && (!fin || len > 125)) return this.close(1002);
      if (len === 126) {
        if (buffer.length < 4) return this.wait(buffer, 4);
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return this.wait(buffer, 10);
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
        len = Number(big);
        offset = 10;
      }
      const end = offset + 4 + len;
      if (buffer.length < end) return this.wait(buffer, end);
      const mask = buffer.subarray(offset, offset + 4);
      const data = Buffer.from(buffer.subarray(offset + 4, end));
      for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
      buffer = buffer.subarray(end);
      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, data));
        continue;
      }
      if (opcode === 0xa) {
        this.onPong?.();
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) return this.close(1003);
      if ((opcode === 0x0) !== (this.fragments.length > 0)) return this.close(1002);
      this.fragments.push(data);
      this.fragmentBytes += data.length;
      if (this.fragmentBytes > MAX_MESSAGE) return this.close(1009);
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        this.onText(text);
        if (this.closed) return;
      }
    }
  }
}
