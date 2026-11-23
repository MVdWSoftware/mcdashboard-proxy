/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** A refusal answered as `{"error": message}`; `reason` labels `mcdp_rejected_total` (default: the status). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly reason: string = String(status),
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  // The API is called from browsers too. These match what the plugin sends itself; authorization travels in a header,
  // never a cookie, so a wildcard origin grants nothing a direct call to the plugin would not.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type, X-MCDashboard-Attestation, X-MCDashboard-Purpose, X-MCDashboard-Entitlement, X-MCDashboard-Player",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

/** Statuses after which the connection is closed: a flooding client, or a request body that was not read. */
const CLOSE_AFTER = new Set([411, 413, 415, 429]);

export function sendJson(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(json));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    connection: CLOSE_AFTER.has(status) ? "close" : "keep-alive",
    ...extra,
  });
  res.end(body);
}

export function sendRaw(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer, method: string, cacheStatus: string): void {
  if (res.headersSent) return;
  // `headers` are the plugin's pass-through headers: when it names a Cache-Control that one wins, otherwise `no-store`.
  const out: Record<string, string | number> = { ...SECURITY_HEADERS, ...headers, "cache-status": `mcdashboard-proxy; ${cacheStatus}` };
  if (status !== 304) out["content-length"] = body.length;
  res.writeHead(status, out);
  res.end(method === "HEAD" || status === 304 ? undefined : body);
}

export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > max) return reject(new HttpError(413, "body too large"));
    if (req.headers["content-length"] === undefined && req.headers["transfer-encoding"] === undefined) return reject(new HttpError(411, "content-length required"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.pause();
        reject(new HttpError(413, "body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
