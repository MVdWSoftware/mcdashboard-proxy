import { describe, expect, it } from "vitest";
import { FallbackStore, RedisStore } from "../src/store.js";

// Runs against a real Redis when REDIS_URL is set (CI starts one).
describe.skipIf(!process.env.REDIS_URL)("RedisStore", () => {
  it("stores values with a ttl and counts atomically per window", async () => {
    const s = new RedisStore(process.env.REDIS_URL!, "mcdp-test:" + Date.now() + ":");
    await s.set("k", Buffer.from("v"), 200);
    expect((await s.get("k"))?.toString()).toBe("v");
    expect(await s.hit("c", 1000)).toBe(1);
    expect(await s.hit("c", 1000)).toBe(2);
    await new Promise((r) => setTimeout(r, 250));
    expect(await s.get("k")).toBeNull();
    await s.close();
  });
});

describe("FallbackStore", () => {
  it("keeps working on local memory while Redis is unreachable", async () => {
    const s = new RedisStore("redis://127.0.0.1:1", "x:");
    const f = new FallbackStore(s, 60_000);
    await f.set("k", Buffer.from("v"), 1000);
    expect((await f.get("k"))?.toString()).toBe("v");
    expect(await f.hit("c", 1000)).toBe(1);
    expect(await f.hit("c", 1000)).toBe(2);
    expect(await f.ping()).toBe(false);
    await f.close();
  });
});
