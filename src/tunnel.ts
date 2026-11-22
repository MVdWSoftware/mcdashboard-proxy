/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Socket } from "node:net";
import { pick } from "./cache.js";
import { applyEvent } from "./events.js";
import type { Metrics } from "./metrics.js";
import type { Revocations } from "./revocations.js";
import { TunnelChannel } from "./tunnel-channel.js";
import type { ChannelHost } from "./tunnel-channel.js";
import { MAX_RESPONSE_BYTES } from "./upstream.js";
import type { UpstreamPort, UpstreamResponse } from "./upstream.js";
import { WsConnection } from "./websocket.js";

type Json = Record<string, unknown>;

/**
 * Version of the tunnel protocol between the plugin and this proxy. Additive changes keep it; bump it only for a change
 * an older plugin cannot ignore. The plugin reports its own protocol in `hello`, so a newer plugin can tell that this
 * proxy is older.
 */
export const TUNNEL_PROTOCOL = 1;

/**
 * API features this proxy carries end to end, matching the plugin's `/v1/info` features. The plugin intersects its own
 * list with this one, so an older proxy (which reports nothing) never makes a new app use a route, query parameter or
 * header it drops.
 */
export const TUNNEL_FEATURES = ["presets", "history-points", "upload", "client-verification", "player-names"] as const;

export interface TunnelStatus {
  connected: boolean;
  server?: string;
  version?: string;
  /** The plugin's tunnel protocol from `hello`; undefined for an older plugin. */
  protocol?: number;
  /** Epoch ms the current connection became ready. */
  since?: number;
  /** Round trip of the last WebSocket ping. */
  rttMs?: number;
  /** Milliseconds since anything was received from the plugin. */
  silentMs?: number;
  inflight: number;
  channels: number;
}

export interface TunnelTiming {
  pingMs: number;
  /** No byte for this long means the plugin is gone (half-open socket, frozen server): the connection is dropped. */
  deadMs: number;
  /** An upgraded socket must say `hello` within this time. */
  helloMs: number;
}

export const DEFAULT_TIMING: TunnelTiming = { pingMs: 20_000, deadMs: 60_000, helloMs: 10_000 };

/**
 * The reverse tunnel (docs/tunnel.md): the single authenticated WebSocket the plugin dialled in on, used as the
 * upstream for REST requests and live channels, and as the source of device events.
 */
export class TunnelHub implements UpstreamPort, ChannelHost {
  private conn: WsConnection | null = null;
  /** The hello was received on `conn`; until then it is never sent requests. */
  private ready = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: UpstreamResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly channels = new Map<number, TunnelChannel>();
  private lastEventId: string | undefined;
  private status: Omit<TunnelStatus, "connected" | "inflight" | "channels" | "silentMs"> = {};
  private watch: NodeJS.Timeout | null = null;
  private pingSentAt = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly maxChannels: number,
    private readonly revocations: Revocations,
    private readonly metrics: Metrics,
    private readonly log: (m: string) => void = () => {},
    private readonly timing: TunnelTiming = DEFAULT_TIMING,
  ) {}

  get connected(): boolean {
    return this.conn !== null && !this.conn.closed && this.ready;
  }

  info(): TunnelStatus {
    return {
      ...this.status,
      connected: this.connected,
      silentMs: this.conn ? Date.now() - this.conn.lastRx : undefined,
      inflight: this.pending.size,
      channels: this.channels.size,
    };
  }

  /** Adopts an authenticated socket (the 101 response has been sent). A newer connection replaces the old one. */
  adopt(socket: Socket, head: Buffer): void {
    if (this.conn) {
      this.log("tunnel: replaced by a new connection");
      this.conn.close(1012);
    }
    this.ready = false;
    const conn: WsConnection = new WsConnection(
      socket,
      (text) => {
        let msg: Json;
        try {
          msg = JSON.parse(text) as Json;
        } catch {
          return conn.close(1007);
        }
        if (this.ready) return this.handle(msg);
        if (msg.t !== "hello") return conn.close(1008);
        this.ready = true;
        clearTimeout(helloTimer);
        const protocol = typeof msg.protocol === "number" && Number.isInteger(msg.protocol) && msg.protocol >= 0 ? msg.protocol : undefined;
        this.status = { server: printable(msg.server, 64), version: printable(msg.version, 32), protocol, since: Date.now() };
        this.metrics.inc("mcdp_tunnel_connects_total");
        // Continuity is unknown on the very first connection: drop per-player entries, like the SSE stream does.
        const resume = this.lastEventId;
        if (!resume) void this.revocations.bumpGeneration();
        conn.send(JSON.stringify({ t: "ready", since: resume ?? null, protocol: TUNNEL_PROTOCOL, features: TUNNEL_FEATURES }));
        this.log(`tunnel: connected (${this.status.server ?? "?"} ${this.status.version ?? ""}${protocol ? `, protocol ${protocol}` : ""})`);
        if (protocol !== undefined && protocol > TUNNEL_PROTOCOL) {
          this.log(`tunnel: the plugin speaks protocol ${protocol} but this proxy speaks ${TUNNEL_PROTOCOL}; features this proxy cannot carry stay hidden until it is updated`);
        }
      },
      () => {
        clearTimeout(helloTimer);
        this.conn = null;
        this.drop();
        this.log("tunnel: disconnected");
      },
    );
    this.conn = conn;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    // Otherwise a socket that never says hello would hold the slot and make a restarted plugin wait.
    const helloTimer = setTimeout(() => {
      if (this.conn === conn && !this.ready) conn.close(1008);
    }, this.timing.helloMs);
    helloTimer.unref();
    conn.onPong = () => {
      if (this.pingSentAt) this.status.rttMs = Date.now() - this.pingSentAt;
    };
    // A half-open socket (plugin host crashed, NAT dropped the mapping) would look connected for hours.
    if (this.watch) clearInterval(this.watch);
    this.watch = setInterval(() => {
      if (Date.now() - conn.lastRx > this.timing.deadMs) {
        this.metrics.inc("mcdp_tunnel_dead_total");
        this.log("tunnel: plugin stopped answering, dropping the connection");
        conn.close(1011);
        return;
      }
      this.pingSentAt = Date.now();
      conn.ping();
    }, this.timing.pingMs);
    this.watch.unref();
    if (head.length) socket.emit("data", head);
  }

  private drop(): void {
    if (this.watch) clearInterval(this.watch);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("tunnel down"));
      this.pending.delete(id);
    }
    for (const ch of [...this.channels.values()]) ch.remoteClosed();
    this.channels.clear();
  }

  private handle(msg: Json): void {
    switch (msg.t) {
      case "res": {
        const id = Number(msg.id);
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        const body = typeof msg.b === "string" ? Buffer.from(msg.b, "base64") : Buffer.alloc(0);
        const status = Number(msg.s);
        if (!Number.isInteger(status) || status < 100 || status > 599 || body.length > MAX_RESPONSE_BYTES) return p.reject(new Error("bad response"));
        p.resolve({ status, headers: pick(lowerHeaders(msg.h)), body });
        return;
      }
      case "d": {
        const ch = this.channels.get(Number(msg.c));
        if (ch && typeof msg.b === "string") ch.receive(Buffer.from(msg.b, "base64"));
        return;
      }
      case "x": {
        const ch = this.channels.get(Number(msg.c));
        if (ch) {
          this.channels.delete(ch.id);
          ch.remoteClosed();
        }
        return;
      }
      case "ev":
        void applyEvent(msg.e, this.revocations, this.metrics).then((ok) => {
          if (ok && typeof msg.id === "string" && msg.id.length <= 64) this.lastEventId = msg.id;
        }).catch(() => {});
        return;
      case "reset":
        this.lastEventId = undefined;
        void this.revocations.bumpGeneration();
        this.metrics.inc("mcdp_events_resets_total");
        return;
      default:
        return; // ignored so the protocol can grow
    }
  }

  send(msg: Json, done?: () => void): boolean {
    return this.conn?.send(JSON.stringify(msg), done) ?? false;
  }

  request(method: string, pathAndQuery: string, headers: Record<string, string>, body?: Buffer): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error("tunnel down"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("upstream timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const { connection: _c, "content-length": _l, ...h } = headers;
      this.send({ t: "req", id, m: method, p: pathAndQuery, h, ...(body ? { b: body.toString("base64") } : {}) });
    });
  }

  /** Opens a byte stream to the plugin's live feed, or null when the tunnel is down or full. */
  openChannel(): TunnelChannel | null {
    if (!this.connected || this.channels.size >= this.maxChannels) return null;
    const id = this.nextId++;
    const ch = new TunnelChannel(this, id);
    this.channels.set(id, ch);
    if (!this.send({ t: "open", c: id })) {
      this.channels.delete(id);
      return null;
    }
    queueMicrotask(() => ch.emit("connect"));
    return ch;
  }

  release(id: number, notifyPlugin: boolean): void {
    if (this.channels.delete(id) && notifyPlugin) this.send({ t: "x", c: id });
  }

  close(): void {
    this.conn?.close(1001);
    if (this.watch) clearInterval(this.watch);
  }
}

function printable(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max).replace(/[^\x20-\x7e]/g, "") : undefined;
}

function lowerHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof h === "object" && h !== null) {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}
