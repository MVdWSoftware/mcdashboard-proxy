/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Redis } from "ioredis";

/** The small key/value surface the proxy needs. Redis in production, memory for tests and single nodes. */
export interface Store {
  get(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, ttlMs: number): Promise<void>;
  /** Atomically counts one hit in a fixed window and returns the new count. */
  hit(key: string, windowMs: number): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const MAX_MEMORY_ENTRIES = 5000;

export class MemoryStore implements Store {
  private readonly data = new Map<string, { v: Buffer; until: number }>();
  private readonly counters = new Map<string, { n: number; until: number }>();

  async get(key: string): Promise<Buffer | null> {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.until <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return e.v;
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    if (this.data.size >= MAX_MEMORY_ENTRIES) this.sweep();
    this.data.set(key, { v: value, until: Date.now() + ttlMs });
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || c.until <= now) {
      if (this.counters.size >= MAX_MEMORY_ENTRIES) this.sweep();
      this.counters.set(key, { n: 1, until: now + windowMs });
      return 1;
    }
    return ++c.n;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.data) if (e.until <= now) this.data.delete(k);
    for (const [k, c] of this.counters) if (c.until <= now) this.counters.delete(k);
    // Still full: drop the oldest insertions so memory stays bounded.
    for (const m of [this.data, this.counters] as Map<string, unknown>[]) {
      while (m.size >= MAX_MEMORY_ENTRIES) m.delete(m.keys().next().value as string);
    }
  }
}

const HIT_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

export class RedisStore implements Store {
  private readonly redis: Redis;

  constructor(url: string, private readonly prefix: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 300, connectTimeout: 2000, retryStrategy: (n) => Math.min(n * 200, 2000) });
    // Outages are handled by FallbackStore; without a listener an error event would crash the process.
    this.redis.on("error", () => {});
  }

  async get(key: string): Promise<Buffer | null> {
    return this.redis.getBuffer(this.prefix + key);
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    await this.redis.set(this.prefix + key, value, "PX", Math.max(1, Math.floor(ttlMs)));
  }

  async hit(key: string, windowMs: number): Promise<number> {
    return Number(await this.redis.eval(HIT_SCRIPT, 1, this.prefix + key, String(windowMs)));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/**
 * Uses the primary store and falls back to a per-process memory store while it is failing, so a
 * Redis outage degrades to local caching and local rate limits instead of taking the API down.
 */
export class FallbackStore implements Store {
  private readonly local = new MemoryStore();
  private downUntil = 0;
  onFallback: () => void = () => {};

  constructor(private readonly primary: Store, private readonly retryMs = 5000) {}

  private async run<T>(op: (s: Store) => Promise<T>): Promise<T> {
    if (Date.now() >= this.downUntil) {
      try {
        return await op(this.primary);
      } catch {
        this.downUntil = Date.now() + this.retryMs;
      }
    }
    this.onFallback();
    return op(this.local);
  }

  get(key: string) {
    return this.run((s) => s.get(key));
  }
  set(key: string, value: Buffer, ttlMs: number) {
    return this.run((s) => s.set(key, value, ttlMs));
  }
  hit(key: string, windowMs: number) {
    return this.run((s) => s.hit(key, windowMs));
  }
  async ping() {
    return this.primary.ping();
  }
  close() {
    return this.primary.close();
  }
}
