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
});
