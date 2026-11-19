/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
let pingResult: string | Error = "PONG";

vi.mock("ioredis", () => ({
  Redis: class {
    on(): void {}
    getBuffer(k: string) { calls.push(["get", k]); return Promise.resolve(Buffer.from("v")); }
    set(...a: unknown[]) { calls.push(["set", ...a]); return Promise.resolve("OK"); }
    eval(...a: unknown[]) { calls.push(["eval", ...a]); return Promise.resolve(3); }
    ping() { return pingResult instanceof Error ? Promise.reject(pingResult) : Promise.resolve(pingResult); }
    disconnect() { calls.push(["disconnect"]); }
  },
}));

const { RedisStore } = await import("../src/store.js");

describe("RedisStore (ioredis mocked)", () => {
  it("prefixes keys, sets a millisecond ttl, counts through the script and reports health", async () => {
    const s = new RedisStore("redis://x", "p:");
    expect((await s.get("k"))?.toString()).toBe("v");
    await s.set("k", Buffer.from("v"), 0.2);
    expect(await s.hit("c", 1000)).toBe(3);
    expect(calls[0]).toEqual(["get", "p:k"]);
    expect(calls[1]).toEqual(["set", "p:k", Buffer.from("v"), "PX", 1]);
    expect(calls[2]?.slice(2)).toEqual([1, "p:c", "1000"]);
    expect(await s.ping()).toBe(true);
    pingResult = "NOPE";
    expect(await s.ping()).toBe(false);
    pingResult = new Error("down");
    expect(await s.ping()).toBe(false);
    await s.close();
    expect(calls.at(-1)).toEqual(["disconnect"]);
  });
});
