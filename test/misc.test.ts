/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { Gate, RateLimiter } from "../src/ratelimit.js";
import { Metrics } from "../src/metrics.js";
import { MemoryStore } from "../src/store.js";
import type { Store } from "../src/store.js";

describe("rate limiter", () => {
  it("allows up to the limit then reports when the window resets", async () => {
    const rl = new RateLimiter(new MemoryStore(), 60);
    expect((await rl.hit("read", "1.1.1.1", 2)).allowed).toBe(true);
    expect((await rl.hit("read", "1.1.1.1", 2)).allowed).toBe(true);
    const third = await rl.hit("read", "1.1.1.1", 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterS).toBeGreaterThanOrEqual(1);
    expect((await rl.hit("read", "2.2.2.2", 2)).allowed).toBe(true);
  });

  it("keeps a counter for two windows, so an evicting Redis drops cache entries first", async () => {
    const ttls: number[] = [];
    const store: Store = {
      get: async () => null,
      set: async () => {},
      hit: async (_key: string, ttlMs: number) => {
        ttls.push(ttlMs);
        return 1;
      },
      ping: async () => true,
      close: async () => {},
    };
    await new RateLimiter(store, 60).hit("read", "x", 1);
    expect(ttls).toEqual([120_000]);
  });
});

describe("concurrency gate", () => {
  it("caps per key and frees slots", () => {
    const g = new Gate(2);
    expect(g.enter("a")).toBe(true);
    expect(g.enter("a")).toBe(true);
    expect(g.enter("a")).toBe(false);
    g.leave("a");
    expect(g.enter("a")).toBe(true);
    g.leave("a");
    g.leave("a");
    g.leave("a"); // unknown after the last leave: stays empty
    expect(g.enter("a")).toBe(true);
  });
});

describe("metrics", () => {
  it("renders counters, labels (sanitised) and gauges", () => {
    const m = new Metrics();
    m.inc("a");
    m.inc("a", {}, 2);
    m.inc("b", { k: 'v"\\\n1' });
    expect(m.render({ g: 4 })).toBe('a 3\nb{k="v1"} 1\ng 4\n');
    expect(new Metrics().render()).toBe("\n");
  });
});
