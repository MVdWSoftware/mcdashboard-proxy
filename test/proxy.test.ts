/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";
import { fakePlugin, get, jwt as sign, startProxy } from "./helpers.js";

const secret = Buffer.alloc(48, 9);
const jwt = (claims: Record<string, unknown>) => sign(claims, secret);

type Stop = () => Promise<unknown>;
const stops: Stop[] = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function setup(env: Record<string, string> = {}, handler?: Parameters<typeof fakePlugin>[0]) {
  const plugin = await fakePlugin(handler);
  const p = await startProxy({ UPSTREAM_URL: `http://127.0.0.1:${plugin.port}`, UPSTREAM_TIMEOUT_MS: "500", ...env });
  stops.push(p.close, plugin.close);
  return { plugin, ...p };
}

describe("caching", () => {
  it("serves anonymous public answers from the cache and only asks the plugin once", async () => {
    const { plugin, port } = await setup();
    const a = await get(port, "/v1/values?ids=tps,online");
    const b = await get(port, "/v1/values?ids=online,tps");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toBe(a.body);
    expect(plugin.seen).toHaveLength(1);
    expect(a.headers["cache-status"]).toContain("miss");
    expect(b.headers["cache-status"]).toContain("hit");
    expect(b.headers["cache-control"]).toBe("public, max-age=2");
    expect(b.headers.server).toBeUndefined();
  });

  it("answers If-None-Match with 304 from the cache", async () => {
    const { plugin, port } = await setup();
    await get(port, "/v1/info");
    const r = await get(port, "/v1/info", { "if-none-match": '"abc"' });
    expect(r.status).toBe(304);
    expect(plugin.seen).toHaveLength(1);
  });

  it("caches per-player answers per caller and never shares them", async () => {
    const { plugin, port } = await setup();
    const alice = { authorization: "Bearer alice.tok.en" };
    const bob = { authorization: "Bearer bob.tok.en" };
    const a1 = await get(port, "/v1/values?ids=player-name", alice);
    const a2 = await get(port, "/v1/values?ids=player-name", alice);
    expect(plugin.seen).toHaveLength(1);
    expect(a2.headers["cache-status"]).toContain("hit");
    expect(a2.headers["cache-control"]).toBe("private, max-age=2");
    expect(a2.body).toBe(a1.body);
    const b1 = await get(port, "/v1/values?ids=player-name", bob);
    expect(plugin.seen).toHaveLength(2);
    expect(b1.body).toContain("bob.tok.en");
    expect(b1.body).not.toContain("alice");
    const anon = await get(port, "/v1/values?ids=player-name");
    expect(plugin.seen).toHaveLength(3);
    expect(anon.body).not.toContain("tok.en");
    expect(anon.headers["cache-control"]).toContain("public");
  });

  it("shares entries between the devices of one verified player but not between players", async () => {
    const { plugin, port } = await setup({ MCD_JWT_SECRET: secret.toString("base64") });
    const exp = Date.now() / 1000 + 60;
    const phone = { authorization: "Bearer " + jwt({ typ: "access", sub: "phone", player: "uuid-1", exp }) };
    const tablet = { authorization: "Bearer " + jwt({ typ: "access", sub: "tablet", player: "uuid-1", exp }) };
    const other = { authorization: "Bearer " + jwt({ typ: "access", sub: "x", player: "uuid-2", exp }) };
    await get(port, "/v1/values?ids=player-name", phone);
    const t = await get(port, "/v1/values?ids=player-name", tablet);
    expect(t.headers["cache-status"]).toContain("hit");
    expect(plugin.seen).toHaveLength(1);
    await get(port, "/v1/values?ids=player-name", other);
    expect(plugin.seen).toHaveLength(2);
  });

  it("does not remember errors for tokens it could not verify", async () => {
    const { plugin, port } = await setup();
    const h = { authorization: "Bearer random.tok.en" };
    for (let i = 0; i < 3; i++) await get(port, "/v1/placeholders/missing", h);
    expect(plugin.seen).toHaveLength(3);
  });

  it("coalesces concurrent misses into one upstream request", async () => {
    const { plugin, port } = await setup();
    plugin.setDelay(100);
    const rs = await Promise.all(Array.from({ length: 10 }, () => get(port, "/v1/info")));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(plugin.seen).toHaveLength(1);
  });

  it("keeps unknown ids away from the plugin after the first miss (negative cache)", async () => {
    const { plugin, port } = await setup();
    for (let i = 0; i < 5; i++) expect((await get(port, "/v1/placeholders/missing")).status).toBe(404);
    expect(plugin.seen).toHaveLength(1);
  });

  it("serves a stale copy while the plugin is down, and 502 when there is none", async () => {
    let down = false;
    const { port, plugin } = await setup({ STALE_IF_ERROR_S: "60" }, (req, res) => {
      if (!down) return false;
      res.destroy();
      return true;
    });
    expect((await get(port, "/v1/info")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2100));
    down = true;
    const r = await get(port, "/v1/info");
    expect(r.status).toBe(200);
    expect(r.headers["cache-status"]).toContain("stale");
    expect((await get(port, "/v1/dashboard")).status).toBe(502);
    expect(plugin.seen.length).toBeGreaterThan(1);
  });
});

describe("cache poisoning", () => {
  it("never remembers a 403, which the plugin answers for a User-Agent it refuses", async () => {
    const { plugin, port } = await setup({}, (req, res) => {
      if (req.headers["user-agent"] !== "bad") return false;
      res.writeHead(403, { "content-type": "application/json" }).end('{"error":"unsupported client"}');
      return true;
    });
    expect((await get(port, "/v1/info", { "user-agent": "bad" })).status).toBe(403);
    expect((await get(port, "/v1/info", { "user-agent": "MCDashboard/1.0.0 (ios)" })).status).toBe(200);
    expect(plugin.seen).toHaveLength(2);
  });

  it("does not serve one device's 401 to the player's other devices", async () => {
    const exp = Date.now() / 1000 + 60;
    const phone = "Bearer " + jwt({ typ: "access", sub: "phone", player: "uuid-1", exp });
    const { plugin, port } = await setup({ MCD_JWT_SECRET: secret.toString("base64") }, (req, res) => {
      if (req.headers.authorization !== phone) return false;
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"token revoked"}');
      return true;
    });
    expect((await get(port, "/v1/values?ids=player-name", { authorization: phone })).status).toBe(401);
    const tablet = { authorization: "Bearer " + jwt({ typ: "access", sub: "tablet", player: "uuid-1", exp }) };
    expect((await get(port, "/v1/values?ids=player-name", tablet)).status).toBe(200);
    expect(plugin.seen).toHaveLength(2);
  });

  it("does not store public answers per unverified token, so random tokens cannot fill the cache", async () => {
    const { plugin, port } = await setup({}, (req, res) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" }).end("[]");
      return true;
    });
    for (let i = 0; i < 3; i++) await get(port, "/v1/info", { authorization: "Bearer junk.tok.en" });
    expect(plugin.seen).toHaveLength(3);
  });

  it("asks the plugin only in a language the cache key tells apart", async () => {
    const { plugin, port } = await setup({ LANGUAGES: "en,nl" });
    await get(port, "/v1/dashboards", { "accept-language": "pt-BR,pt;q=0.9" });
    await get(port, "/v1/dashboard", { "accept-language": "nl-BE,pt;q=0.9" });
    expect(plugin.seen[0]!.headers["accept-language"]).toBeUndefined();
    expect(plugin.seen[1]!.headers["accept-language"]).toBe("nl");
  });

  it("does not store answers that vary on a header outside the key", async () => {
    const { plugin, port } = await setup({}, (req, res) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60", vary: "User-Agent" }).end("[]");
      return true;
    });
    await get(port, "/v1/info");
    await get(port, "/v1/info");
    expect(plugin.seen).toHaveLength(2);
  });
});

describe("protection", () => {
  it("answers unknown routes and bad queries without touching the plugin", async () => {
    const { plugin, port } = await setup();
    expect((await get(port, "/admin")).status).toBe(404);
    expect((await get(port, "/v1/values?ids=a&x=1")).status).toBe(400);
    expect((await get(port, "/v1/info", {}, "PUT")).status).toBe(405);
    expect((await get(port, "/v1/info?" + "a".repeat(5000))).status).toBe(414);
    expect(plugin.seen).toHaveLength(0);
  });

  it("rate limits pairing per client (the plugin's own limit is 10/minute)", async () => {
    const { plugin, port } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await get(port, "/v1/auth", { "content-type": "application/json" }, "POST", '{"code":"ABCD-2345"}')).status);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    expect(plugin.seen).toHaveLength(10);
    const r = await get(port, "/v1/auth", { "content-type": "application/json" }, "POST", "{}");
    expect(r.headers["retry-after"]).toBeDefined();
  });

  it("limits bodies and requires JSON", async () => {
    const { plugin, port } = await setup({ MAX_BODY_BYTES: "100" });
    expect((await get(port, "/v1/auth", { "content-type": "application/json" }, "POST", "x".repeat(101))).status).toBe(413);
    expect((await get(port, "/v1/auth", { "content-type": "text/plain" }, "POST", "{}")).status).toBe(415);
    expect(plugin.seen).toHaveLength(0);
  });

  it("rejects invalid tokens at the edge when the secret is configured", async () => {
    const { plugin, port } = await setup({ MCD_JWT_SECRET: secret.toString("base64") });
    const bad = await get(port, "/v1/values?ids=tps", { authorization: "Bearer aaa.bbb.ccc" });
    expect(bad.status).toBe(401);
    expect(bad.headers["www-authenticate"]).toContain("invalid_token");
    expect((await get(port, "/v1/values?ids=tps", { authorization: "Basic abc" })).status).toBe(401);
    expect(plugin.seen).toHaveLength(0);
    const ok = await get(port, "/v1/values?ids=tps", { authorization: "Bearer " + jwt({ typ: "access", sub: "d", exp: Date.now() / 1000 + 60 }) });
    expect(ok.status).toBe(200);
    expect(plugin.seen).toHaveLength(1);
  });

  it("throttles clients that keep sending bad tokens", async () => {
    const { port } = await setup({ MCD_JWT_SECRET: secret.toString("base64"), RATE_BAD_TOKEN: "3" });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get(port, "/v1/info", { authorization: "Bearer a.b.c" })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it("sheds load with 503 instead of queueing when the plugin is saturated", async () => {
    const { plugin, port } = await setup({ MAX_UPSTREAM_CONCURRENCY: "2", MAX_CONCURRENT_PER_IP: "50" });
    plugin.setDelay(200);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => get(port, `/v1/placeholders/p${i}`)));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 503).length).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
    expect(plugin.seen.length).toBeLessThan(6);
  });

  it("does not forward arbitrary client headers and overwrites X-Forwarded-For", async () => {
    const { plugin, port } = await setup();
    await get(port, "/v1/info", { "x-forwarded-for": "6.6.6.6", cookie: "a=b", "x-evil": "1", "x-mcdashboard-player": "Steve" });
    const h = plugin.seen[0]!.headers;
    expect(h["x-forwarded-for"]).toBe("127.0.0.1");
    expect(h["x-mcdashboard-player"]).toBe("Steve");
    expect(h.cookie).toBeUndefined();
    expect(h["x-evil"]).toBeUndefined();
  });

  it("answers 400 to a request target it cannot parse", async () => {
    const { plugin, port } = await setup();
    const sock = connect(port, "127.0.0.1");
    stops.push(async () => sock.destroy());
    const head = await new Promise<string>((resolve) => {
      sock.on("connect", () => sock.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
      sock.once("data", (d) => resolve(d.toString()));
    });
    expect(head).toMatch(/^HTTP\/1.1 400/);
    expect(plugin.seen).toHaveLength(0);
  });

  it("closes the connection after refusing a body it did not read", async () => {
    const { port } = await setup({ MAX_BODY_BYTES: "100" });
    const r = await get(port, "/v1/auth", { "content-type": "application/json" }, "POST", "x".repeat(101));
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe("close");
  });

  it("counts each rejection once, under its reason", async () => {
    const { proxy, port } = await setup({ RATE_READ: "1" });
    await get(port, "/v1/info");
    expect((await get(port, "/v1/info")).status).toBe(429);
    const metrics = proxy.metrics.render();
    expect(metrics).toContain('mcdp_rejected_total{reason="rate_limit"} 1');
    expect(metrics).not.toContain('reason="429"');
  });
});

describe("revoked devices", () => {
  const exp = () => Date.now() / 1000 + 60;
  const device = (sub: string, player = "uuid-1") => ({ authorization: "Bearer " + jwt({ typ: "access", sub, player, exp: exp() }) });

  it("refuses a revoked device even when its player's answer is cached, and keeps serving the player's other devices", async () => {
    const plugin = await fakePlugin();
    const store = new MemoryStore();
    const revocations = new Revocations(store, 3600);
    const p = await startProxy({ UPSTREAM_URL: `http://127.0.0.1:${plugin.port}`, MCD_JWT_SECRET: secret.toString("base64") }, store, revocations);
    stops.push(p.close, plugin.close);
    const phone = device("phone");
    const tablet = device("tablet");
    expect((await get(p.port, "/v1/values?ids=player-name", phone)).status).toBe(200);
    expect((await get(p.port, "/v1/values?ids=player-name", tablet)).headers["cache-status"]).toContain("hit");

    await revocations.deny("phone");
    const r = await get(p.port, "/v1/values?ids=player-name", phone);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toBe("device revoked");
    expect(r.headers["www-authenticate"]).toContain("invalid_token");
    expect((await get(p.port, "/v1/values?ids=player-name", tablet)).status).toBe(200);
    expect(plugin.seen).toHaveLength(1);
  });

  it("also works without the secret, by the device id in the token", async () => {
    const plugin = await fakePlugin();
    const store = new MemoryStore();
    const revocations = new Revocations(store, 3600);
    const p = await startProxy({ UPSTREAM_URL: `http://127.0.0.1:${plugin.port}` }, store, revocations);
    stops.push(p.close, plugin.close);
    const h = device("phone");
    expect((await get(p.port, "/v1/values?ids=player-name", h)).status).toBe(200);
    await revocations.deny("phone");
    expect((await get(p.port, "/v1/values?ids=player-name", h)).status).toBe(401);
  });

  it("drops every per-player entry when the generation changes, but keeps public ones", async () => {
    const plugin = await fakePlugin();
    const store = new MemoryStore();
    const revocations = new Revocations(store, 3600);
    const p = await startProxy({ UPSTREAM_URL: `http://127.0.0.1:${plugin.port}`, MCD_JWT_SECRET: secret.toString("base64") }, store, revocations);
    stops.push(p.close, plugin.close);
    const h = device("phone");
    await get(p.port, "/v1/values?ids=player-name", h);
    await get(p.port, "/v1/info");
    expect(plugin.seen).toHaveLength(2);
    await revocations.bumpGeneration();
    await get(p.port, "/v1/values?ids=player-name", h);
    await get(p.port, "/v1/info");
    expect(plugin.seen).toHaveLength(3);
  });
});
