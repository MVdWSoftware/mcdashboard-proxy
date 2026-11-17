/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Metrics } from "./metrics.js";
import type { Revocations } from "./revocations.js";
import { endpoint } from "./upstream.js";

/** Mirrors `DeviceRevokedEvent` in openapi.yaml of the MCDashboard-plugin repository. */
export interface DeviceRevokedEvent {
  type: "device.revoked";
  epoch: string;
  seq: number;
  time: number;
  deviceId: string;
  player: string;
}

export function isDeviceRevokedEvent(v: unknown): v is DeviceRevokedEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.type === "device.revoked" && typeof e.epoch === "string" && typeof e.seq === "number" && typeof e.time === "number"
    && typeof e.deviceId === "string" && e.deviceId.length > 0 && e.deviceId.length <= 128 && typeof e.player === "string";
}

/** Applies a decoded event; shared by the stream and the webhook so both behave the same. Unknown types are ignored. */
export async function applyEvent(payload: unknown, revocations: Revocations, metrics: Metrics): Promise<boolean> {
  if (!isDeviceRevokedEvent(payload)) return false;
  await revocations.deny(payload.deviceId);
  metrics.inc("mcdp_revocations_total");
  return true;
}

export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

/** Incremental `text/event-stream` parser (WHATWG HTML §9.2): LF, CRLF or CR line ends, `:` comments, multi-line data. */
export class SseParser {
  private buffer = "";
  private id: string | undefined;
  private event = "";
  private data: string[] = [];

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let m: RegExpExecArray | null;
    const line = /\r\n|\n|\r/g;
    let start = 0;
    while ((m = line.exec(this.buffer)) !== null) {
      // A lone CR at the very end may be the first half of a CRLF.
      if (m[0] === "\r" && line.lastIndex === this.buffer.length) break;
      const text = this.buffer.slice(start, m.index);
      start = line.lastIndex;
      if (text === "") {
        if (this.data.length > 0 || this.event !== "") out.push({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
        this.event = "";
        this.data = [];
      } else if (!text.startsWith(":")) {
        const c = text.indexOf(":");
        const field = c < 0 ? text : text.slice(0, c);
        const value = c < 0 ? "" : text.slice(c + 1).replace(/^ /, "");
        if (field === "id" && !value.includes("\0")) this.id = value;
        else if (field === "event") this.event = value;
        else if (field === "data") this.data.push(value);
      }
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > 64 * 1024) this.buffer = "";
    return out;
  }
}

export interface EventStreamOptions {
  url: URL;
  token: string;
  revocations: Revocations;
  metrics: Metrics;
  /** No bytes for this long (the plugin pings every 15 s) means the connection is dead. */
  idleMs?: number;
  log?: (message: string) => void;
}

/**
 * Follows the plugin's `GET /v1/events` stream. It reconnects with backoff and `Last-Event-ID`; when continuity
 * cannot be guaranteed (first connect, or the plugin answers `reset`) it bumps the cache generation, which drops
 * every per-player entry, so nothing revoked in the gap can be served from cache.
 */
export class EventStream {
  private lastId: string | undefined;
  private attempt = 0;
  private req: ClientRequest | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  connected = false;

  constructor(private readonly o: EventStreamOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.req?.destroy();
  }

  private connect(): void {
    const { url, token } = this.o;
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { accept: "text/event-stream", authorization: `Bearer ${token}`, "cache-control": "no-cache" };
    if (this.lastId) headers["last-event-id"] = this.lastId;
    const req = request(
      { ...endpoint(url), path: "/v1/events", method: "GET", headers, agent: false },
      (res) => {
        if (res.statusCode !== 200 || !String(res.headers["content-type"]).startsWith("text/event-stream")) {
          this.o.log?.(`events: plugin answered ${res.statusCode} (404 = events.token not set, 401 = wrong token)`);
          res.resume();
          return this.retry();
        }
        this.attempt = 0;
        this.connected = true;
        this.o.metrics.inc("mcdp_events_connects_total");
        this.watchdog(res);
        const parser = new SseParser();
        res.setEncoding("utf8");
        // Continuity is unknown on the first connect.
        let chain: Promise<void> = this.lastId ? Promise.resolve() : this.o.revocations.bumpGeneration();
        res.on("data", (chunk: string) => {
          this.watchdog(res);
          for (const msg of parser.feed(chunk)) chain = chain.then(() => this.handle(msg)).catch(() => {});
        });
        res.on("end", () => this.retry());
        res.on("error", () => this.retry());
      },
    );
    req.on("error", () => this.retry());
    req.end();
    this.req = req;
  }

  private async handle(msg: SseMessage): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (msg.event === "reset") {
      await this.o.revocations.bumpGeneration();
      this.o.metrics.inc("mcdp_events_resets_total");
      return;
    }
    if (await applyEvent(payload, this.o.revocations, this.o.metrics) && msg.id) this.lastId = msg.id;
  }

  private watchdog(res: IncomingMessage): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => res.destroy(new Error("stream idle")), this.o.idleMs ?? 45_000);
    this.timer.unref();
  }

  private retry(): void {
    if (this.stopped) return;
    this.connected = false;
    this.req?.destroy();
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref();
  }
}
