/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { AddressList, bucket, ClientIp } from "../src/clientip.js";

describe("client address", () => {
  const c = new ClientIp(["10.0.0.0/8", "::1"]);
  it("ignores X-Forwarded-For from untrusted peers", () => {
    expect(c.resolve("203.0.113.9", "1.2.3.4")).toBe("203.0.113.9");
  });
  it("takes the right-most non-trusted hop from trusted peers, so a spoofed left value is ignored", () => {
    expect(c.resolve("10.0.0.2", "6.6.6.6, 198.51.100.7, 10.1.1.1")).toBe("198.51.100.7");
    expect(c.resolve("::ffff:10.0.0.2", "198.51.100.7")).toBe("198.51.100.7");
  });
  it("matches addresses and subnets, and refuses invalid entries at startup", () => {
    const l = new AddressList(["192.0.2.0/24", "2001:db8::1"], "X");
    expect(l.has("192.0.2.77")).toBe(true);
    expect(l.has("198.51.100.1")).toBe(false);
    expect(l.has("2001:db8::1")).toBe(true);
    expect(l.has("not-an-ip")).toBe(false);
    expect(() => new AddressList(["nope"], "X")).toThrow("X: invalid address nope");
  });
  it("buckets IPv6 by /64", () => {
    expect(bucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(bucket("2001:db8:1:2::1"));
    expect(bucket("2001:db8:1:3::1")).not.toBe(bucket("2001:db8:1:2::1"));
  });
  it("reads the request headers and socket", () => {
    const req = (remote: string | undefined, xff?: string | string[]) => ({ socket: { remoteAddress: remote }, headers: { "x-forwarded-for": xff } }) as never;
    expect(c.of(req("10.0.0.2", ["1.1.1.1", "198.51.100.7"]))).toBe("198.51.100.7");
    expect(c.of(req("203.0.113.9", "1.1.1.1"))).toBe("203.0.113.9");
    expect(c.of(req(undefined))).toBe("");
  });
  it("skips garbage hops and keeps the peer when every hop is trusted", () => {
    expect(c.resolve("10.0.0.2", "garbage, 10.9.9.9")).toBe("10.9.9.9");
    expect(c.resolve("10.0.0.2", "garbage")).toBe("10.0.0.2");
    expect(c.resolve("10.0.0.2", undefined)).toBe("10.0.0.2");
  });
  it("accepts an IPv4 subnet written with an IPv6 mapped peer and an empty list", () => {
    expect(new AddressList([], "X").empty).toBe(true);
    expect(new ClientIp([]).resolve("::ffff:1.2.3.4", "9.9.9.9")).toBe("1.2.3.4");
    expect(new ClientIp([]).resolve("::ffff:zz", undefined)).toBe("::ffff:zz");
  });
  it("buckets plain IPv4 as is and expands compressed IPv6", () => {
    expect(bucket("1.2.3.4")).toBe("1.2.3.4");
    expect(bucket("::1")).toBe("0:0:0:0::/64");
    expect(bucket("2001:DB8::")).toBe("2001:db8:0:0::/64");
    expect(bucket("1:2:3:4:5:6:7:8")).toBe("1:2:3:4::/64");
  });
});
