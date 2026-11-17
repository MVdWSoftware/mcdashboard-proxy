import type { Store } from "./store.js";

const GENERATION_MEMO_MS = 2000;
const GENERATION_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * What the proxy knows about revoked devices, kept in the shared store so every node agrees.
 *
 * - The deny list holds device ids (the `sub` of their tokens) for as long as such a token could still be valid.
 * - The generation is part of every per-player cache key. Bumping it drops all per-player entries at once; it is
 *   the answer to "we may have missed a revocation" (stream restarted from scratch, plugin restarted).
 */
export class Revocations {
  private memo = { value: "0", until: 0 };

  constructor(private readonly store: Store, private readonly ttlS: number) {}

  async deny(deviceId: string): Promise<void> {
    await this.store.set(`rev:${deviceId}`, Buffer.from("1"), this.ttlS * 1000);
  }

  async isDenied(deviceId: string): Promise<boolean> {
    return (await this.store.get(`rev:${deviceId}`)) !== null;
  }

  async generation(): Promise<string> {
    const now = Date.now();
    if (this.memo.until > now) return this.memo.value;
    const raw = await this.store.get("gen");
    this.memo = { value: raw ? raw.toString("utf8") : "0", until: now + GENERATION_MEMO_MS };
    return this.memo.value;
  }

  /** Invalidates every per-player cache entry on every node (within the memo interval). */
  async bumpGeneration(): Promise<void> {
    const value = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    await this.store.set("gen", Buffer.from(value), GENERATION_TTL_MS);
    this.memo = { value, until: Date.now() + GENERATION_MEMO_MS };
  }
}
