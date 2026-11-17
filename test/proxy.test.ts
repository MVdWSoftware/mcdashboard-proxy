import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { fakePlugin, get, startProxy } from "./helpers.js";
import { Revocations } from "../src/revocations.js";
import { MemoryStore } from "../src/store.js";

const secret = Buffer.alloc(48, 9);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};

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
    const b = await get(port, "/v1/values?ids=online,tps"); // other order, same entry
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toBe(a.body);
    expect(plugin.seen).toHaveLength(1);
    expect(a.headers["cache-status"]).toContain("miss");
    expect(b.headers["cache-status"]).toContain("hit");
    expect(b.headers["cache-control"]).toBe("public, max-age=2");
    expect(b.headers.server).toBeUndefined(); // upstream internals are not leaked
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
    expect(plugin.seen).toHaveLength(1); // second one from the cache
    expect(a2.headers["cache-status"]).toContain("hit");
    expect(a2.headers["cache-control"]).toBe("private, max-age=2"); // stays private towards clients
    expect(a2.body).toBe(a1.body);
    const b1 = await get(port, "/v1/values?ids=player-name", bob);
    expect(plugin.seen).toHaveLength(2); // Bob does not get Alice's entry
    expect(b1.body).toContain("bob.tok.en");
    expect(b1.body).not.toContain("alice");
    const anon = await get(port, "/v1/values?ids=player-name");
    expect(plugin.seen).toHaveLength(3); // anonymous does not get a player's entry either
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
    await new Promise((r) => setTimeout(r, 2100)); // past max-age=2
    down = true;
    const r = await get(port, "/v1/info");
    expect(r.status).toBe(200);
    expect(r.headers["cache-status"]).toContain("stale");
    expect((await get(port, "/v1/dashboard")).status).toBe(502);
    expect(plugin.seen.length).toBeGreaterThan(1);
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
    await get(port, "/v1/info", { "x-forwarded-for": "6.6.6.6", cookie: "a=b", "x-evil": "1" });
    const h = plugin.seen[0]!.headers;
    expect(h["x-forwarded-for"]).toBe("127.0.0.1");
    expect(h.cookie).toBeUndefined();
    expect(h["x-evil"]).toBeUndefined();
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
    expect((await get(p.port, "/v1/values?ids=player-name", tablet)).headers["cache-status"]).toContain("hit"); // shared player scope

    await revocations.deny("phone");
    const r = await get(p.port, "/v1/values?ids=player-name", phone);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toBe("device revoked");
    expect(r.headers["www-authenticate"]).toContain("invalid_token");
    expect((await get(p.port, "/v1/values?ids=player-name", tablet)).status).toBe(200);
    expect(plugin.seen).toHaveLength(1); // the revoked request never reached the plugin, the other device still hits the cache
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
    expect(plugin.seen).toHaveLength(3); // only the per-player one went back to the plugin
  });
});
