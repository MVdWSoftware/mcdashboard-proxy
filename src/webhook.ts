import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Metrics } from "./metrics.js";
import type { Revocations } from "./revocations.js";
import { applyEvent } from "./events.js";

const MAX_BODY = 8 * 1024;

/** `sha256=<hex>` of HMAC-SHA256 over `<timestamp>.<raw body>`, as the plugin signs it (WebhookDispatcher.sign). */
export function sign(secret: string, timestampS: number | string, body: Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestampS}.`).update(body).digest("hex");
}

export function verify(secret: string, timestamp: string | undefined, signature: string | undefined, body: Buffer, toleranceS: number, nowMs = Date.now()): string | null {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return "missing timestamp";
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceS) return "timestamp outside tolerance";
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : "bad signature";
}

/**
 * Receives the plugin's `events.webhooks` deliveries. Runs on its own port (`WEBHOOK_PORT`), off by default;
 * every request must carry a valid signature and a fresh timestamp. Answers `204` once the event is applied,
 * and also for event types it does not know, so the plugin does not retry them.
 */
export function createWebhookServer(secret: string, toleranceS: number, revocations: Revocations, metrics: Metrics): http.Server {
  return http.createServer({ maxHeaderSize: 4096, requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
    const fail = (status: number, message: string) => {
      metrics.inc("mcdp_webhook_rejected_total", { status: String(status) });
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: message }));
    };
    if (req.url !== "/hooks/mcdashboard") return fail(404, "not found");
    if (req.method !== "POST") return fail(405, "method not allowed");
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const sig = req.headers["x-mcdashboard-signature"];
      const ts = req.headers["x-mcdashboard-timestamp"];
      const bad = verify(secret, typeof ts === "string" ? ts : undefined, typeof sig === "string" ? sig : undefined, body, toleranceS);
      if (bad) return fail(401, bad);
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return fail(400, "invalid JSON");
      }
      applyEvent(payload, revocations, metrics).then(
        () => res.writeHead(204, { "cache-control": "no-store" }).end(),
        () => fail(500, "could not record the event"), // the plugin retries
      );
    });
  });
}
