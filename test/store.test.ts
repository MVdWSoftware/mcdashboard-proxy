/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackStore, MemoryStore } from "../src/store.js";
import type { Store } from "../src/store.js";

afterEach(() => vi.useRealTimers());

describe("memory store", () => {
  it("expires values and windows", async () => {
    vi.useFakeTimers();
    const s = new MemoryStore();
    await s.set("k", Buffer.from("v"), 100);
    expect((await s.get("k"))?.toString()).toBe("v");
    expect(await s.get("missing")).toBeNull();
    expect(await s.hit("c", 100)).toBe(1);
    expect(await s.hit("c", 100)).toBe(2);
    vi.advanceTimersByTime(150);
    expect(await s.get("k")).toBeNull();
    expect(await s.hit("c", 100)).toBe(1);
    expect(await s.ping()).toBe(true);
    await s.close();
  });

  it("stays bounded: sweeps expired entries, then drops the oldest", async () => {
    vi.useFakeTimers();
    const s = new MemoryStore();
    for (let i = 0; i < 5000; i++) await s.set(`old${i}`, Buffer.from("x"), 10);
    vi.advanceTimersByTime(100);
    await s.set("fresh", Buffer.from("y"), 10_000); // sweep removes the expired
    expect(await s.get("old1")).toBeNull();
    expect((await s.get("fresh"))?.toString()).toBe("y");
    for (let i = 0; i < 5000; i++) await s.set(`live${i}`, Buffer.from("x"), 10_000); // nothing expired: oldest dropped
    expect(await s.get("fresh")).toBeNull();
    expect(await s.get("live4999")).not.toBeNull();
    for (let i = 0; i < 5001; i++) await s.hit(`c${i}`, 10_000);
    for (let i = 0; i < 5001; i++) await s.hit(`d${i}`, 5);
    vi.advanceTimersByTime(10);
    await s.hit("again", 10);
    expect(await s.hit("c5000", 10_000)).toBeGreaterThan(0);
  });
});

describe("fallback store", () => {
  const failing = (): Store => ({
    get: () => Promise.reject(new Error("down")),
    set: () => Promise.reject(new Error("down")),
    hit: () => Promise.reject(new Error("down")),
    ping: () => Promise.resolve(false),
    close: () => Promise.resolve(),
  });

  it("uses the primary while it works", async () => {
    const primary = new MemoryStore();
    const f = new FallbackStore(primary);
    await f.set("k", Buffer.from("v"), 1000);
    expect((await primary.get("k"))?.toString()).toBe("v");
    expect(await f.hit("c", 1000)).toBe(1);
    expect(await f.ping()).toBe(true);
    await f.close();
  });

  it("falls back, reports it, and retries the primary after the pause", async () => {
    vi.useFakeTimers();
    let flips = 0;
    const down = failing();
    const f = new FallbackStore(down, 1000);
    f.onFallback = () => flips++;
    await f.set("k", Buffer.from("v"), 5000);
    expect(flips).toBe(1);
    expect((await f.get("k"))?.toString()).toBe("v");
    expect(flips).toBe(2);
    vi.advanceTimersByTime(1500);
    await f.hit("c", 1000); // retries the primary, fails again
    expect(flips).toBe(3);
  });
});
