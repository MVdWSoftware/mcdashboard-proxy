/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";

/** A socket stand-in that records what is written and lets a test feed data in. */
export class FakeSocket extends EventEmitter {
  destroyed = false;
  written: Buffer[] = [];
  ended = false;
  noDelay = false;
  idle: number | null = null;

  write(data: Buffer | string, cb?: () => void): boolean {
    this.written.push(Buffer.from(data));
    cb?.();
    return true;
  }
  end(data?: Buffer | string, cb?: () => void): this {
    if (data) this.written.push(Buffer.from(data));
    this.ended = true;
    cb?.();
    return this;
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  }
  setNoDelay(): this {
    this.noDelay = true;
    return this;
  }
  setTimeout(ms: number): this {
    this.idle = ms;
    return this;
  }
  /** Writes as text, for HTTP style replies. */
  text(): string {
    return Buffer.concat(this.written).toString();
  }
  /** Decodes the unmasked server frames written so far. */
  frames(): { opcode: number; payload: Buffer }[] {
    const out: { opcode: number; payload: Buffer }[] = [];
    let buf = Buffer.concat(this.written);
    while (buf.length >= 2) {
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      out.push({ opcode: buf[0]! & 0x0f, payload: buf.subarray(off, off + len) });
      buf = buf.subarray(off + len);
    }
    return out;
  }
}

/** A client (masked) WebSocket frame. */
export function clientFrame(payload: Buffer | string, opcode = 0x1, fin = true, rsv = 0): Buffer {
  const data = Buffer.from(payload);
  const mask = Buffer.from([9, 8, 7, 6]);
  const b0 = (fin ? 0x80 : 0) | rsv | opcode;
  const n = data.length;
  let head: Buffer;
  if (n < 126) head = Buffer.from([b0, 0x80 | n]);
  else if (n < 65536) head = Buffer.from([b0, 0x80 | 126, n >> 8, n & 255]);
  else {
    head = Buffer.from([b0, 0x80 | 127, 0, 0, 0, 0, 0, 0, 0, 0]);
    head.writeUInt32BE(n, 6);
  }
  return Buffer.concat([head, mask, Buffer.from(data.map((b, i) => b ^ mask[i % 4]!))]);
}
