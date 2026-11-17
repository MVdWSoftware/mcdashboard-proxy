import { createHash } from "node:crypto";
import type { Store } from "./store.js";

export interface Cached {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  storedAt: number;
  /** Freshness lifetime in seconds. */
  maxAge: number;
}

/** Response headers that are kept; everything else the plugin sends is dropped. */
export const PASS_HEADERS = ["content-type", "cache-control", "etag", "vary", "content-language", "www-authenticate", "retry-after"];

export function pick(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of PASS_HEADERS) {
    const v = headers[h];
    if (typeof v === "string") out[h] = v;
  }
  return out;
}

/**
 * Freshness for a response, or null when it must not be stored. Anonymous requests store only
 * shared-cacheable (`public`) answers. `private` (per-player) answers are stored only under that
 * player's scope (see `ResponseCache.key`), never shared; `no-store` is never stored.
 * Errors that carry no cache headers (404/401/403) are kept briefly so a flood of bad
 * requests is absorbed here.
 */
export function freshness(status: number, headers: Record<string, string>, negativeTtlS: number, scoped: boolean): number | null {
  const cc = (headers["cache-control"] ?? "").toLowerCase();
  if (/(^|,\s*)(no-store|no-cache)\b/.test(cc)) return null;
  const isPrivate = /(^|,\s*)private\b/.test(cc);
  // `private` answers are stored only under a per-player scope; anonymous requests never see them.
  if (isPrivate && !scoped) return null;
  if (status === 200) {
    const m = /(?:^|,\s*)(?:s-maxage|max-age)=(\d+)/.exec(cc);
    if (!m || !(isPrivate || /(^|,\s*)public\b/.test(cc))) return null;
    const age = Number(m[1]);
    return age > 0 ? age : null;
  }
  if ((status === 401 || status === 403 || status === 404) && negativeTtlS > 0) return negativeTtlS;
  return null;
}

export class ResponseCache {
  constructor(private readonly store: Store, private readonly staleIfErrorS: number, private readonly maxBody: number) {}

  /** `scope` is "" for anonymous requests, or the identity of the caller (`p:<player>` / `t:<token hash>`). */
  static key(path: string, query: string, languages: string, scope = ""): string {
    return "c:" + createHash("sha256").update(`${path}?${query}|${languages}|${scope}`).digest("base64url").slice(0, 32);
  }

  async get(key: string): Promise<Cached | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw.toString("utf8")) as Omit<Cached, "body"> & { body: string };
      return { ...j, body: Buffer.from(j.body, "base64") };
    } catch {
      return null;
    }
  }

  async put(key: string, entry: Cached): Promise<void> {
    if (entry.body.length > this.maxBody) return;
    const payload = Buffer.from(JSON.stringify({ ...entry, body: entry.body.toString("base64") }));
    await this.store.set(key, payload, (entry.maxAge + this.staleIfErrorS) * 1000);
  }

  static age(e: Cached, now = Date.now()): number {
    return Math.max(0, Math.floor((now - e.storedAt) / 1000));
  }

  static fresh(e: Cached, now = Date.now()): boolean {
    return ResponseCache.age(e, now) < e.maxAge;
  }

  /** Stale copies may be served while the plugin is failing, for a bounded time. */
  usableStale(e: Cached, now = Date.now()): boolean {
    return ResponseCache.age(e, now) < e.maxAge + this.staleIfErrorS;
  }
}
