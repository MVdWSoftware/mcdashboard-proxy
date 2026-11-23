/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import type { Store } from "../src/store.js";
import { fakePlugin, get, startProxy } from "./helpers.js";

type Stop = () => Promise<unknown>;
const stops: Stop[] = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function setup(env: Record<string, string> = {}, handler?: Parameters<typeof fakePlugin>[0], store?: Store) {
  const plugin = await fakePlugin(handler);
  const p = await startProxy({ UPSTREAM_URL: `http://127.0.0.1:${plugin.port}`, UPSTREAM_TIMEOUT_MS: "500", ...env }, store);
  stops.push(p.close, plugin.close);
  return { plugin, ...p };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("proxy limits and failures", () => {
  it("limits concurrent requests per client", async () => {
    const { plugin, port } = await setup({ MAX_CONCURRENT_PER_IP: "1" });
    plugin.setDelay(300);
    const slow = get(port, "/v1/info");
    await sleep(50);
    expect((await get(port, "/v1/info")).status).toBe(429);
    expect((await slow).status).toBe(200);
  });

  it("answers 500 when something unexpected fails, without leaking details", async () => {
    const broken: Store = { get: async () => null, set: async () => {}, hit: () => Promise.reject(new Error("secret detail")), ping: async () => true, close: async () => {} };
    const { port } = await setup({}, undefined, broken);
    const r = await get(port, "/v1/info");
    expect(r.status).toBe(500);
    expect(r.body).not.toContain("secret");
  });

  it("forwards non-cacheable calls untouched, with and without a conditional header", async () => {
    const { plugin, port } = await setup({}, (_req, res) => { res.writeHead(204).end(); return true; });
    expect((await get(port, "/v1/devices/self", { authorization: "Bearer a.b.c" }, "DELETE")).status).toBe(204);
    expect((await get(port, "/v1/devices/self", { authorization: "Bearer a.b.c", "if-none-match": '"x"' }, "DELETE")).status).toBe(204);
    expect(plugin.seen.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("lists the allowed methods, adding HEAD only where GET is allowed", async () => {
    const { port } = await setup();
    expect((await get(port, "/v1/auth")).headers.allow).toBe("POST");
    expect((await get(port, "/v1/info", {}, "PUT")).headers.allow).toBe("GET, HEAD");
  });

  it("requires a content type on bodies", async () => {
    const { port } = await setup();
    expect((await get(port, "/v1/auth", {}, "POST", "{}")).status).toBe(415);
  });

  it("keeps working when the store cannot save", async () => {
    const mem = new MemoryStore();
    const flaky: Store = { get: (k) => mem.get(k), set: () => Promise.reject(new Error("x")), hit: (k, w) => mem.hit(k, w), ping: () => mem.ping(), close: () => mem.close() };
    const { port } = await setup({}, undefined, flaky);
    expect((await get(port, "/v1/info")).status).toBe(200);
  });
});

describe("revalidation and stale answers", () => {
  it("renews a stale entry when the plugin answers 304", async () => {
    const { plugin, port } = await setup();
    const first = await get(port, "/v1/info");
    expect(first.headers["cache-status"]).toContain("miss");
    await sleep(2100);
    const second = await get(port, "/v1/info");
    expect(second.status).toBe(200);
    expect(second.headers["cache-status"]).toContain("revalidated");
    expect(plugin.seen[1]?.headers["if-none-match"]).toBe('"abc"');
  });

  it("passes a 304 through when there was nothing cached", async () => {
    const { port } = await setup({}, (_req, res) => { res.writeHead(304).end(); return true; });
    expect((await get(port, "/v1/info")).status).toBe(304);
  });

  it("serves the stale copy on a plugin 5xx, and a generic error when nothing is cached", async () => {
    let fail = false;
    const { port } = await setup({}, (_req, res) => { if (!fail) return false; res.writeHead(500, { "content-type": "text/plain" }).end("secret stack trace"); return true; });
    expect((await get(port, "/v1/info")).status).toBe(200);
    fail = true;
    await sleep(2100);
    const stale = await get(port, "/v1/info");
    expect(stale.status).toBe(200);
    expect(stale.headers["cache-status"]).toContain("stale");
    const r = await get(port, "/v1/dashboard");
    expect(r.status).toBe(500);
    // The plugin's error body can name hosts and internals, and it is never cacheable.
    expect(r.body).toBe('{"error":"upstream error"}');
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("passes a 4xx body on but marks it no-store", async () => {
    const { port } = await setup({}, (_req, res) => {
      res.writeHead(426, { "content-type": "application/json" }).end('{"error":"update the app"}');
      return true;
    });
    const r = await get(port, "/v1/info");
    expect(r.status).toBe(426);
    expect(r.body).toBe('{"error":"update the app"}');
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("conditional requests on bypassed answers", async () => {
    const { port } = await setup();
    const r = await get(port, "/v1/info", { "if-none-match": '"abc"' });
    expect(r.status).toBe(304);
  });
});

describe("readiness", () => {
  it("is ready while the plugin answers, even when Redis is down (the memory fallback keeps serving)", async () => {
    const a = await setup();
    expect(await a.proxy.ready()).toBe(true);
    const mem = new MemoryStore();
    const b = await setup({}, undefined, { get: (k) => mem.get(k), set: (k, v, t) => mem.set(k, v, t), hit: (k, w) => mem.hit(k, w), ping: async () => false, close: async () => {} });
    expect(await b.proxy.ready()).toBe(true);
    const c = await startProxy({ UPSTREAM_URL: "http://127.0.0.1:1" });
    stops.push(c.close);
    expect(await c.proxy.ready()).toBe(false);
    const d = await startProxy({ TUNNEL_TOKEN: "k".repeat(40) });
    stops.push(d.close);
    expect(await d.proxy.ready()).toBe(false);
    const e = await setup({}, (_req, res) => { res.writeHead(503).end(); return true; });
    expect(await e.proxy.ready()).toBe(false);
  });
});
