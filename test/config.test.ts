/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const secret = Buffer.alloc(32, 7).toString("base64");

describe("config", () => {
  it("has working defaults", () => {
    const c = loadConfig({});
    expect(c.listenPort).toBe(8080);
    expect(c.jwtSecret).toBeNull();
    expect(c.tunnelToken).toBeNull();
    expect(c.eventsToken).toBeNull();
    expect(c.webhookSecret).toBeNull();
    expect(c.languages).toContain("nl");
    expect(c.upstream.href).toBe("http://127.0.0.1:1553/");
  });

  it("reads every override", () => {
    const c = loadConfig({
      LISTEN_HOST: "1.2.3.4", LISTEN_PORT: "81", ADMIN_HOST: "::1", ADMIN_PORT: "0",
      UPSTREAM_URL: "https://a.example", UPSTREAM_LIVE_URL: "http://b.example:9",
      REDIS_URL: "redis://x", REDIS_KEY_PREFIX: "p:", TRUSTED_PROXIES: " 10.0.0.0/8, ,::1 ",
      MCD_JWT_SECRET: ` ${secret} `, LANGUAGES: "EN, ,Nl", MAX_BODY_BYTES: "5", RATE_READ: "7",
      TUNNEL_TOKEN: "t".repeat(32), TUNNEL_PATH: "/mytunnel", TUNNEL_ALLOWED_IPS: "1.1.1.1, 2.2.2.2",
      EVENTS_TOKEN: " tok ", WEBHOOK_SECRET: "s".repeat(16), WEBHOOK_HOST: "0.0.0.0", WEBHOOK_PORT: "9100",
    });
    expect(c.listenHost).toBe("1.2.3.4");
    expect(c.redisUrl).toBe("redis://x");
    expect(c.trustedProxies).toEqual(["10.0.0.0/8", "::1"]);
    expect(c.jwtSecret?.length).toBe(32);
    expect(c.languages).toEqual(["en", "nl"]);
    expect(c.tunnelToken).toHaveLength(32);
    expect(c.tunnelPath).toBe("/mytunnel");
    expect(c.tunnelAllowedIps).toEqual(["1.1.1.1", "2.2.2.2"]);
    expect(c.eventsToken).toBe("tok");
    expect(c.webhookSecret).toHaveLength(16);
    expect(c.webhookPort).toBe(9100);
    expect(c.limits.read).toBe(7);
  });

  it("treats an empty value as unset", () => {
    expect(loadConfig({ LISTEN_PORT: "", UPSTREAM_URL: "" }).listenPort).toBe(8080);
  });

  it.each([
    [{ LISTEN_PORT: "abc" }, /LISTEN_PORT must be an integer >= 1/],
    [{ LISTEN_PORT: "0" }, /LISTEN_PORT/],
    [{ UPSTREAM_URL: "ftp://x" }, /UPSTREAM_URL must be http/],
    [{ MCD_JWT_SECRET: "abc" }, /at least 32 bytes/],
    [{ WEBHOOK_SECRET: "short" }, /at least 16/],
    [{ WEBHOOK_PORT: "9100" }, /needs WEBHOOK_SECRET/],
    [{ TUNNEL_TOKEN: "short" }, /at least 32/],
    [{ TUNNEL_PATH: "tunnel" }, /plain path/],
    [{ TUNNEL_PATH: "/v1/x" }, /plain path/],
  ])("rejects %j", (env, msg) => {
    expect(() => loadConfig(env)).toThrow(msg);
  });
});
