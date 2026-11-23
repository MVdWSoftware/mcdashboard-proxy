/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { canonicalLanguages, canonicalQuery, match } from "../src/routes.js";

const m = (method: string, url: string) => {
  const u = new URL(url, "http://x");
  return match(method, u.pathname, u.searchParams);
};

describe("route allowlist", () => {
  it("accepts the contract routes", () => {
    for (const [method, url] of [
      ["GET", "/v1/info"], ["POST", "/v1/auth"], ["POST", "/v1/auth/refresh"], ["GET", "/v1/placeholders?q=tps&limit=10"],
      ["GET", "/v1/placeholders/max-players"], ["GET", "/v1/values?ids=a,b"], ["GET", "/v1/history/tps?since=100"],
      ["GET", "/v1/history/tps?since=100&points=150"],
      ["GET", "/v1/dashboards"], ["POST", "/v1/dashboards"], ["GET", "/v1/dashboards/main"], ["GET", "/v1/dashboard"],
      ["DELETE", "/v1/devices/self"],
    ] as const) expect(m(method, url).kind, `${method} ${url}`).toBe("route");
  });

  it("rejects unknown paths, wrong methods and odd ids", () => {
    expect(m("GET", "/v1/admin").kind).toBe("notFound");
    expect(m("GET", "/v1/placeholders/a%2Fb").kind).toBe("notFound");
    expect(m("GET", "/v1/dashboards/UPPER").kind).toBe("notFound");
    expect(m("PUT", "/v1/info")).toEqual({ kind: "methodNotAllowed", allow: ["GET"] });
  });

  it("validates the query so it cannot be used to bust the cache", () => {
    expect(m("GET", "/v1/values").kind).toBe("badRequest");
    expect(m("GET", "/v1/values?ids=a&x=1").kind).toBe("badRequest");
    expect(m("GET", "/v1/values?ids=a&ids=b").kind).toBe("badRequest");
    expect(m("GET", "/v1/values?ids=" + Array.from({ length: 101 }, (_, i) => "p" + i).join(",")).kind).toBe("badRequest");
    expect(m("GET", "/v1/placeholders?limit=101").kind).toBe("badRequest");
    expect(m("GET", "/v1/info?x=1").kind).toBe("badRequest");
  });

  it("does not cache requests whose validated parameters are unbounded in combination", () => {
    const cacheable = (url: string) => {
      const r = m("GET", url);
      return r.kind === "route" && r.route.cacheable;
    };
    expect(cacheable("/v1/placeholders")).toBe(true);
    expect(cacheable("/v1/placeholders?ids=a,b")).toBe(true);
    expect(cacheable("/v1/placeholders?limit=10&offset=20")).toBe(true);
    expect(cacheable("/v1/placeholders?q=tps")).toBe(false);
    expect(cacheable("/v1/placeholders?group=player")).toBe(false);
    expect(cacheable("/v1/history/tps")).toBe(true);
    expect(cacheable("/v1/history/tps?since=100")).toBe(false);
    expect(cacheable("/v1/history/tps?points=150")).toBe(false);
    expect(cacheable("/v1/values?ids=a,b")).toBe(true);
  });

  it("canonicalises the query and language", () => {
    expect(canonicalQuery(new URLSearchParams("ids=b,a&x=1"))).toBe(canonicalQuery(new URLSearchParams("x=1&ids=a,b")));
    expect(canonicalLanguages("nl-BE,nl;q=0.9,en;q=0.8,xx;q=0.7", ["en", "nl"])).toBe("nl,en");
    expect(canonicalLanguages("zz", ["en", "nl"])).toBe("");
    expect(canonicalLanguages(undefined, ["en"])).toBe("");
  });
  it("covers the remaining validators and methods", () => {
    expect(m("HEAD", "/v1/info").kind).toBe("route");
    expect(m("GET", "/v1/placeholders?ids=").kind).toBe("route");
    expect(m("GET", "/v1/placeholders?ids=a,b").kind).toBe("route");
    expect(m("GET", "/v1/placeholders?ids=a,b%20c")).toEqual({ kind: "badRequest", message: "ids contains an invalid placeholder id" });
    expect(m("GET", "/v1/values?ids=")).toEqual({ kind: "badRequest", message: "ids must list 1-100 placeholder ids" });
    expect(m("GET", "/v1/placeholders?q=" + "x".repeat(65))).toEqual({ kind: "badRequest", message: "q is too long" });
    expect(m("GET", "/v1/placeholders?limit=0").kind).toBe("badRequest");
    expect(m("GET", "/v1/history/tps?since=abc").kind).toBe("badRequest");
    expect(m("GET", "/v1/history/tps?since=100&points=1").kind).toBe("badRequest");
    expect(m("GET", "/v1/history/tps?since=100&points=2001").kind).toBe("badRequest");
    expect(m("GET", "/v1/history/tps?since=100&points=x").kind).toBe("badRequest");
  });

  it("orders query keys and honours q weights", () => {
    expect(canonicalQuery(new URLSearchParams("b=1&a=2&b=0&c=3"))).toBe("a=2&b=1&b=0&c=3");
    expect(canonicalQuery(new URLSearchParams("a=1&a=0"))).toBe("a=1&a=0");
    expect(canonicalLanguages("en;q=0, nl;q=0.5, de, fr; q=0.7, es;level=1", ["en", "nl", "de", "fr", "es"])).toBe("de,es,fr,nl");
    expect(canonicalLanguages("en,en-GB,EN", ["en"])).toBe("en");
  });
});
