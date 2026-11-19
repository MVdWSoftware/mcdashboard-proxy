/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { endpoint, MAX_RESPONSE_BYTES, Upstream } from "../src/upstream.js";

describe("upstream client", () => {
  it("derives host and port from a URL", () => {
    expect(endpoint(new URL("http://[::1]:99/"))).toEqual({ host: "::1", port: 99 });
    expect(endpoint(new URL("https://a.example"))).toEqual({ host: "a.example", port: 443 });
    expect(endpoint(new URL("http://a.example"))).toEqual({ host: "a.example", port: 80 });
  });

  it("sends a body and returns status, headers and body; handles a missing status", async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/big") return void res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1));
        if (req.url === "/slow") return; // never answers
        res.writeHead(201, { "content-type": "text/plain", etag: '"x"' }).end(`${req.method}:${Buffer.concat(chunks)}`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const up = new Upstream(new URL(`http://127.0.0.1:${port}`), 4, 300);
    try {
      const r = await up.request("POST", "/x", { "x-a": "b" }, Buffer.from("hello"));
      expect(r.status).toBe(201);
      expect(r.body.toString()).toBe("POST:hello");
      expect(r.headers.etag).toBe('"x"');
      expect((await up.request("GET", "/x", {})).body.toString()).toBe("GET:");
      await expect(up.request("GET", "/big", {})).rejects.toThrow();
      await expect(up.request("GET", "/slow", {})).rejects.toThrow("upstream timeout");
    } finally {
      up.close();
      server.closeAllConnections();
      server.close();
    }
  });

  it("uses https for https upstreams", async () => {
    const up = new Upstream(new URL("https://127.0.0.1:1"), 1, 300);
    await expect(up.request("GET", "/", {})).rejects.toThrow();
    up.close();
  });
});
