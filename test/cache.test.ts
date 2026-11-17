/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { freshness, pick } from "../src/cache.js";

describe("cache rules", () => {
  const pub = { "cache-control": "public, max-age=60" };
  const priv = { "cache-control": "private, max-age=10" };

  it("stores public answers for everyone and private ones only under a scope", () => {
    expect(freshness(200, pub, "anonymous", 5)).toBe(60);
    expect(freshness(200, priv, "anonymous", 5)).toBeNull();
    expect(freshness(200, priv, "player", 5)).toBe(10);
    expect(freshness(200, pub, "unverified", 5)).toBeNull();
    expect(freshness(200, priv, "unverified", 5)).toBe(10);
    expect(freshness(200, { "cache-control": "no-store" }, "player", 5)).toBeNull();
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
    expect(freshness(200, { ...pub, vary: "User-Agent" }, "anonymous", 5)).toBeNull();
    expect(freshness(200, { ...pub, vary: "*" }, "anonymous", 5)).toBeNull();
  });

  it("keeps only listed response headers with values a client may receive", () => {
    expect(pick({ "content-type": "text/plain", server: "x", etag: '"a"\r\nset-cookie: x=1' })).toEqual({ "content-type": "text/plain" });
  });
});
