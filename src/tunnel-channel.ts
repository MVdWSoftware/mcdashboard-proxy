/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Duplex } from "node:stream";

/** What a channel needs from the tunnel it travels over. */
export interface ChannelHost {
  send(msg: Record<string, unknown>, done?: () => void): boolean;
  release(id: number, notifyPlugin: boolean): void;
}

/** Bytes per `d` message; base64 adds a third, which keeps every message far below the frame limit. */
const PIECE = 48 * 1024;

/** A live-feed byte stream carried by the tunnel, usable wherever the live relay expects a socket. */
export class TunnelChannel extends Duplex {
  private idle: NodeJS.Timeout | null = null;
  private idleMs = 0;
  private idleCb: (() => void) | null = null;

  constructor(private readonly host: ChannelHost, readonly id: number) {
    super({ allowHalfOpen: false });
  }

  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.touch();
    if (chunk.length === 0) return cb();
    for (let i = 0; i < chunk.length; i += PIECE) {
      const last = i + PIECE >= chunk.length;
      const sent = this.host.send({ t: "d", c: this.id, b: chunk.subarray(i, i + PIECE).toString("base64") }, last ? () => cb() : undefined);
      if (!sent) return cb(new Error("tunnel down"));
    }
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    if (this.idle) clearTimeout(this.idle);
    this.host.release(this.id, true);
    cb(err);
  }

  /** Same contract as `Socket#setTimeout`: calls `cb` after `ms` without traffic. */
  setTimeout(ms: number, cb?: () => void): this {
    this.idleMs = ms;
    this.idleCb = cb ?? null;
    this.touch();
    return this;
  }

  receive(data: Buffer): void {
    this.touch();
    this.push(data);
  }

  remoteClosed(): void {
    this.push(null);
    this.destroy();
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.idleMs > 0) {
      this.idle = setTimeout(() => this.idleCb?.(), this.idleMs);
      this.idle.unref();
    }
  }
}
