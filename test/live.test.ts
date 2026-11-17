import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startProxy } from "./helpers.js";

const closers: (() => unknown)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

/** A stand-in live port that completes the handshake and echoes bytes. */
async function fakeLive() {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.once("data", () => { s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); s.on("data", (d) => s.write(d)); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => { sockets.forEach((s) => s.destroy()); server.close(); });
  return (server.address() as net.AddressInfo).port;
}

function upgrade(port: number, path = "/v1/live") {
  return new Promise<{ head: string; sock: net.Socket }>((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.once("data", (d) => resolve({ head: d.toString(), sock }));
    closers.push(() => sock.destroy());
  });
}

describe("live feed tunnel", () => {
  it("tunnels the upgrade and the frames, and limits connections per client", async () => {
    const live = await fakeLive();
    const p = await startProxy({ UPSTREAM_LIVE_URL: `http://127.0.0.1:${live}`, MAX_LIVE_PER_IP: "2" });
    closers.push(p.close);
    const a = await upgrade(p.port);
    expect(a.head).toContain("101 Switching Protocols");
    const echoed = new Promise<string>((r) => a.sock.once("data", (d) => r(d.toString())));
    a.sock.write("ping");
    expect(await echoed).toBe("ping");
    await upgrade(p.port);
    expect((await upgrade(p.port)).head).toContain("429");
  });

  it("passes the User-Agent on, because the plugin only serves the official app", async () => {
    const seen: string[] = [];
    const server = net.createServer((s) => s.once("data", (d) => { seen.push(d.toString()); s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.close());
    const p = await startProxy({ UPSTREAM_LIVE_URL: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` });
    closers.push(p.close);
    const sock = net.connect(p.port, "127.0.0.1");
    closers.push(() => sock.destroy());
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("GET /v1/live HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nUser-Agent: MCDashboard/1.0.0 (android)\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    expect(seen[0]).toContain("User-Agent: MCDashboard/1.0.0 (android)");
  });

  it("refuses other paths", async () => {
    const p = await startProxy({});
    closers.push(p.close);
    expect((await upgrade(p.port, "/v1/other")).head).toContain("404");
  });
});
