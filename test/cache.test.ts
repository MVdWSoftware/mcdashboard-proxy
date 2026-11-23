/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { canonicalPlayer, freshness, pick, ResponseCache } from "../src/cache.js";
import { MemoryStore } from "../src/store.js";

describe("cache rules", () => {
  const pub = { "cache-control": "public, max-age=60" };
  const priv = { "cache-control": "private, max-age=10" };

  it("stores public answers for everyone and private ones only under a scope", () => {
    expect(freshness(200, pub, "anonymous", 5)).toBe(60);
    expect(freshness(200, priv, "anonymous", 5)).toBeNull();
    expect(freshness(200, priv, "player", 5)).toBe(10);
    expect(freshness(200, priv, "token", 5)).toBe(10);
    expect(freshness(200, { "cache-control": "no-store" }, "player", 5)).toBeNull();
  });

  it("never stores answers for a token it cannot verify, so random tokens cannot fill the cache", () => {
    expect(freshness(200, pub, "unverified", 5)).toBeNull();
    expect(freshness(200, priv, "unverified", 5)).toBeNull();
  });

  it("remembers errors only where they cannot leak to another client", () => {
    expect(freshness(404, {}, "anonymous", 5)).toBe(5);
    expect(freshness(404, {}, "player", 5)).toBe(5);
    expect(freshness(401, {}, "anonymous", 5)).toBe(5);
    expect(freshness(401, {}, "player", 5)).toBeNull();
    expect(freshness(403, {}, "anonymous", 5)).toBeNull();
    expect(freshness(404, {}, "unverified", 5)).toBeNull();
    expect(freshness(404, {}, "anonymous", 0)).toBeNull();
  });

  it("honours Vary only for headers the key covers", () => {
    expect(freshness(200, { ...pub, vary: "Authorization, Accept-Language" }, "anonymous", 5)).toBe(60);
    // allow-player-names servers: the typed player is part of the key, so their answers may be stored.
    expect(freshness(200, { ...pub, vary: "Authorization, X-MCDashboard-Player" }, "anonymous", 5)).toBe(60);
    expect(freshness(200, { ...pub, vary: "User-Agent" }, "anonymous", 5)).toBeNull();
    expect(freshness(200, { ...pub, vary: "*" }, "anonymous", 5)).toBeNull();
  });

  it("keeps only listed response headers with values a client may receive", () => {
    expect(pick({ "content-type": "text/plain", server: "x", etag: '"a"\r\nset-cookie: x=1' })).toEqual({ "content-type": "text/plain" });
  });

  it("canonicalises the typed player name", () => {
    expect(canonicalPlayer(undefined)).toBe("");
    expect(canonicalPlayer("  Steve ")).toBe("steve");
  });
});

describe("response cache", () => {
  const entry = (over = {}) => ({ status: 200, headers: { etag: '"a"' }, body: Buffer.from("hello"), storedAt: Date.now(), maxAge: 10, ...over });

  it("keys differ per path, query, language, scope and typed player", () => {
    const k = ResponseCache.key("/v1/info", "", "en");
    expect(k).toMatch(/^c:/);
    expect(ResponseCache.key("/v1/info", "", "en", "p:x")).not.toBe(k);
    expect(ResponseCache.key("/v1/info", "a=1", "en")).not.toBe(k);
    expect(ResponseCache.key("/v1/info", "", "en", "n:steve", "steve")).not.toBe(k);
    expect(ResponseCache.key("/v1/info", "", "en", "n:steve", "steve")).not.toBe(ResponseCache.key("/v1/info", "", "en", "n:alex", "alex"));
  });

  it("stores, reads back and skips oversized bodies", async () => {
    const store = new MemoryStore();
    const c = new ResponseCache(store, 60, 8);
    expect(await c.get("x")).toBeNull();
    await c.put("x", entry());
    expect((await c.get("x"))?.body.toString()).toBe("hello");
    await c.put("big", entry({ body: Buffer.alloc(9) }));
    expect(await c.get("big")).toBeNull();
    await store.set("bad", Buffer.from("not json"), 1000);
    expect(await c.get("bad")).toBeNull();
  });

  it("knows fresh, stale-usable and age", () => {
    const c = new ResponseCache(new MemoryStore(), 60, 100);
    const now = Date.now();
    expect(ResponseCache.fresh(entry({ storedAt: now - 5000 }))).toBe(true);
    expect(ResponseCache.fresh(entry({ storedAt: now - 11_000 }))).toBe(false);
    expect(c.usableStale(entry({ storedAt: now - 20_000 }))).toBe(true);
    expect(c.usableStale(entry({ storedAt: now - 100_000 }))).toBe(false);
    expect(ResponseCache.age(entry({ storedAt: now - 3000 }), now)).toBe(3);
    expect(ResponseCache.age(entry({ storedAt: now + 3000 }), now)).toBe(0);
  });

  it("edge cases of the rules", () => {
    expect(freshness(200, { "cache-control": "public, max-age=0" }, "anonymous", 5)).toBeNull();
    expect(freshness(200, { "cache-control": "public" }, "anonymous", 5)).toBeNull();
    expect(freshness(200, {}, "anonymous", 5)).toBeNull();
    expect(freshness(200, { "cache-control": "max-age=5" }, "anonymous", 5)).toBeNull();
  });
});
