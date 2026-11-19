/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";
import { ClientIp } from "../src/clientip.js";
import { loadConfig } from "../src/config.js";
import { Metrics } from "../src/metrics.js";
import { RateLimiter } from "../src/ratelimit.js";
import { MemoryStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import { tunnelUpgrade } from "../src/tunnel-upgrade.js";
import { FakeSocket } from "./fakes.js";

const KEY = "k".repeat(40);

function setup(env: Record<string, string> = {}, store: Store = new MemoryStore(), token: string | null = KEY) {
  const config = loadConfig({ RATE_AUTH: "2", ...(token ? { TUNNEL_TOKEN: token } : {}), ...env });
  const hub = { adopt: vi.fn() };
  const metrics = new Metrics();
  const handler = tunnelUpgrade(config, hub as never, new RateLimiter(store, 60), new ClientIp([]), metrics);
  const attempt = async (headers: Record<string, string>, ip = "203.0.113.5", method = "GET") => {
    const socket = new FakeSocket();
    handler({ method, headers: { upgrade: "websocket", "sec-websocket-key": "abc", ...headers }, socket: { remoteAddress: ip } } as never, socket as never, Buffer.alloc(0));
    await new Promise((r) => setTimeout(r, 10));
    return socket;
  };
  return { hub, metrics, attempt };
}

describe("tunnel upgrade", () => {
  it("adopts a socket that presents the key", async () => {
    const { hub, attempt } = setup();
    const s = await attempt({ authorization: `Bearer ${KEY}` });
    expect(s.text()).toContain("101");
    expect(hub.adopt).toHaveBeenCalledTimes(1);
  });

  it("refuses non-WebSocket requests, wrong or missing keys and a non-Bearer scheme", async () => {
    const { hub, metrics, attempt } = setup({ RATE_AUTH: "50" });
    expect((await attempt({}, "203.0.113.5", "POST")).text()).toContain("404");
    expect((await attempt({ authorization: "Bearer wrong" })).text()).toContain("401");
    expect((await attempt({})).text()).toContain("401");
    expect((await attempt({ authorization: `Basic ${KEY}` })).text()).toContain("401");
    expect(hub.adopt).not.toHaveBeenCalled();
    expect(metrics.render()).toContain('mcdp_tunnel_rejected_total{reason="key"} 3');
  });

  it("only talks to allowed addresses", async () => {
    const { metrics, attempt } = setup({ TUNNEL_ALLOWED_IPS: "198.51.100.0/24" });
    expect((await attempt({ authorization: `Bearer ${KEY}` }, "203.0.113.5")).text()).toContain("404");
    expect((await attempt({ authorization: `Bearer ${KEY}` }, "198.51.100.9")).text()).toContain("101");
    expect(metrics.render()).toContain('reason="address"');
  });

  it("throttles attempts", async () => {
    const { metrics, attempt } = setup({ RATE_AUTH: "1" });
    await attempt({ authorization: "Bearer x" });
    expect((await attempt({ authorization: "Bearer x" })).text()).toContain("429");
    expect(metrics.render()).toContain('reason="rate_limit"');
  });

  it("answers 503 when the limiter fails, and tolerates a missing token in the config", async () => {
    const broken: Store = { get: async () => null, set: async () => {}, hit: () => Promise.reject(new Error("x")), ping: async () => true, close: async () => {} };
    expect((await setup({}, broken).attempt({})).text()).toContain("503");
    expect((await setup({}, new MemoryStore(), null).attempt({ authorization: "Bearer a" })).text()).toContain("401");
  });
});
