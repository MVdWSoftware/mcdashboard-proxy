import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { Socket } from "node:net";
import type http from "node:http";
import { Duplex } from "node:stream";
import type { Config } from "./config.js";
import { bucket, ClientIp, normalize } from "./clientip.js";
import { pick } from "./cache.js";
import { applyEvent } from "./events.js";
import type { Metrics } from "./metrics.js";
import type { Revocations } from "./revocations.js";
import type { RateLimiter } from "./ratelimit.js";
import type { UpstreamPort, UpstreamResponse } from "./upstream.js";

/**
 * The reverse tunnel. The plugin dials out to the proxy over ONE WebSocket and everything else travels over it:
 * REST requests (proxy -> plugin), live-feed byte streams (both ways) and device events (plugin -> proxy). The
 * proxy never connects to the Minecraft server, so the server needs no inbound port besides the small discovery
 * endpoint (`/v1/info`). Protocol: docs/tunnel.md.
 */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type Json = Record<string, unknown>;

/** Server side of RFC 6455 for text frames only: reads masked client frames, writes unmasked ones. */
class WsConnection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  closed = false;
  /** When any byte last arrived: the dead-peer watchdog compares it with the clock. */
  lastRx = Date.now();
  /** The hello was received; until then the connection is not used. */
  ready = false;
  onPong: (() => void) | null = null;

  constructor(readonly socket: Socket, private readonly onText: (text: string) => void, private readonly onClose: () => void) {
    socket.on("data", (d: Buffer) => this.feed(d));
    socket.on("close", () => this.finish());
    socket.on("error", () => socket.destroy());
  }

  send(text: string, done?: () => void): boolean {
    if (this.closed || this.socket.destroyed) return false;
    const payload = Buffer.from(text, "utf8");
    this.socket.write(frame(0x1, payload), done);
    return true;
  }

  ping(): void {
    if (!this.closed) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code);
    this.socket.end(frame(0x8, body));
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose();
  }

  private feed(chunk: Buffer): void {
    this.lastRx = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (!masked || (b0 & 0x70) !== 0) return this.close(1002); // clients must mask; no extensions negotiated
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const data = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + len);
      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, data));
        continue;
      }
      if (opcode === 0xa) {
        this.onPong?.();
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) return this.close(1003); // binary frames are not part of the protocol
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

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** A live-feed connection carried by the tunnel. Behaves like the socket the proxy used to open to the plugin. */
export class TunnelChannel extends Duplex {
  private idle: NodeJS.Timeout | null = null;
  private idleMs = 0;
  private idleCb: (() => void) | null = null;

  constructor(private readonly hub: TunnelHub, readonly id: number) {
    super({ allowHalfOpen: false });
  }

  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.touch();
    for (let i = 0; i < chunk.length; i += 48 * 1024) {
      if (!this.hub.send({ t: "d", c: this.id, b: chunk.subarray(i, i + 48 * 1024).toString("base64") }, i + 48 * 1024 >= chunk.length ? () => cb() : undefined)) return cb(new Error("tunnel down"));
    }
    if (chunk.length === 0) cb();
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    if (this.idle) clearTimeout(this.idle);
    this.hub.release(this.id, true);
    cb(err);
  }

  /** Same contract as `net.Socket#setTimeout`: calls `cb` after `ms` without traffic. */
  setTimeout(ms: number, cb?: () => void): this {
    this.idleMs = ms;
    this.idleCb = cb ?? null;
    this.touch();
    return this;
  }

  /** Data from the plugin. */
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

export interface TunnelStatus {
  connected: boolean;
  server?: string;
  version?: string;
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
  /** A ping is sent this often. */
  pingMs: number;
  /** No byte for this long means the plugin is gone (half-open socket, frozen server): the connection is dropped. */
  deadMs: number;
  /** An upgraded socket must say `hello` within this time. */
  helloMs: number;
}

export const DEFAULT_TIMING: TunnelTiming = { pingMs: 20_000, deadMs: 60_000, helloMs: 10_000 };

/** The single, authenticated connection from the plugin, seen as an upstream for REST requests and live channels. */
export class TunnelHub implements UpstreamPort {
  private conn: WsConnection | null = null;
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

  /** True once the plugin said hello: a connection that has not is never sent requests. */
  get connected(): boolean {
    return this.conn !== null && !this.conn.closed && this.conn.ready;
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
    let helloDone = false;
    const conn: WsConnection = new WsConnection(
      socket,
      (text) => {
        let msg: Json;
        try {
          msg = JSON.parse(text) as Json;
        } catch {
          return conn.close(1007);
        }
        if (!helloDone) {
          if (msg.t !== "hello") return conn.close(1008);
          helloDone = true;
          conn.ready = true;
          clearTimeout(helloTimer);
          this.status = { server: str(msg.server, 64), version: str(msg.version, 32), since: Date.now() };
          this.metrics.inc("mcdp_tunnel_connects_total");
          // Continuity is unknown on the very first connection: drop per-player entries, like the SSE stream does.
          const resume = this.lastEventId;
          if (!resume) void this.revocations.bumpGeneration();
          conn.send(JSON.stringify({ t: "ready", since: resume ?? null }));
          this.log(`tunnel: connected (${this.status.server ?? "?"} ${this.status.version ?? ""})`);
          return;
        }
        this.handle(msg);
      },
      () => {
        clearTimeout(helloTimer);
        if (this.conn !== conn) return;
        this.conn = null;
        this.drop();
        this.log("tunnel: disconnected");
      },
    );
    this.conn = conn;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    // A socket that never says hello would otherwise occupy the slot (and make a restarted plugin wait).
    const helloTimer = setTimeout(() => {
      if (!helloDone) conn.close(1008);
    }, this.timing.helloMs);
    helloTimer.unref();
    conn.onPong = () => {
      if (this.pingSentAt) this.status.rttMs = Date.now() - this.pingSentAt;
    };
    // Health check: ping regularly and drop a connection that has been silent too long. Without this a half-open
    // socket (plugin host crashed, NAT dropped the mapping) would look connected for hours and every request would time out.
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
        return; // unknown frames are ignored so the protocol can grow
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

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max).replace(/[^\x20-\x7e]/g, "") : undefined;
}

function lowerHeaders(h: unknown): Record<string, string | string[] | undefined> {
  const out: Record<string, string> = {};
  if (typeof h === "object" && h !== null) {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

/** Which peers may even try to open the tunnel. Empty = anyone holding the key. */
export class TunnelAcl {
  private readonly list = new BlockList();
  readonly restricted: boolean;

  constructor(entries: string[]) {
    this.restricted = entries.length > 0;
    for (const e of entries) {
      const [addr, bits] = e.split("/");
      const family = isIP(addr ?? "");
      if (!addr || !family) throw new Error(`TUNNEL_ALLOWED_IPS: invalid address ${e}`);
      const type = family === 6 ? "ipv6" : "ipv4";
      if (bits === undefined) this.list.addAddress(addr, type);
      else this.list.addSubnet(addr, Number(bits), type);
    }
  }

  allows(ip: string): boolean {
    if (!this.restricted) return true;
    const fam = isIP(ip);
    return fam !== 0 && this.list.check(ip, fam === 6 ? "ipv6" : "ipv4");
  }
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * Accepts the plugin's connection on `config.tunnelPath`. Checks, in this order: path/handshake shape, the allowed
 * addresses (anything else gets a plain 404, so the endpoint is not revealed), a rate limit on attempts per client,
 * and the API key in `Authorization: Bearer` (constant-time comparison). Only then is the socket upgraded.
 */
export function attachTunnel(server: http.Server, config: Config, hub: TunnelHub, limiter: RateLimiter, clients: ClientIp, metrics: Metrics): void {
  const acl = new TunnelAcl(config.tunnelAllowedIps);
  const expected = digest(config.tunnelToken ?? "");
  server.on("upgrade", (req, duplex, head) => {
    const socket = duplex as Socket;
    const path = (req.url ?? "").split("?")[0];
    if (path !== config.tunnelPath) return; // the live feed (or a refusal) is handled elsewhere
    const refuse = (status: string, extra = "") => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
    socket.on("error", () => socket.destroy());
    const xff = req.headers["x-forwarded-for"];
    const ip = clients.resolve(normalize(req.socket.remoteAddress ?? ""), Array.isArray(xff) ? xff.join(",") : xff);
    const key = req.headers["sec-websocket-key"];
    if (req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket" || typeof key !== "string" || key.length > 64) return refuse("404 Not Found");
    if (!acl.allows(ip)) {
      metrics.inc("mcdp_tunnel_rejected_total", { reason: "address" });
      return refuse("404 Not Found");
    }
    limiter.hit("tunnel", bucket(ip), config.limits.auth).then((rl) => {
      if (!rl.allowed) {
        metrics.inc("mcdp_tunnel_rejected_total", { reason: "rate_limit" });
        return refuse("429 Too Many Requests", `Retry-After: ${rl.retryAfterS}\r\n`);
      }
      const h = req.headers.authorization ?? "";
      const given = digest(h.startsWith("Bearer ") ? h.slice(7).trim() : "");
      if (!timingSafeEqual(given, expected)) {
        metrics.inc("mcdp_tunnel_rejected_total", { reason: "key" });
        return refuse("401 Unauthorized", "WWW-Authenticate: Bearer\r\n");
      }
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      hub.adopt(socket, head);
    }).catch(() => refuse("503 Service Unavailable"));
  });
}
