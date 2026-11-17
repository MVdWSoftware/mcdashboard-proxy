import type { Store } from "./store.js";

/** Fixed-window per-client counters kept in the shared store, so every proxy node sees the same count. */
export class RateLimiter {
  constructor(private readonly store: Store, private readonly windowS: number) {}

  /** Counts one hit; `retryAfterS` is the time until the window resets. */
  async hit(scope: string, client: string, limit: number): Promise<{ allowed: boolean; retryAfterS: number }> {
    const windowMs = this.windowS * 1000;
    const count = await this.store.hit(`rl:${scope}:${client}:${Math.floor(Date.now() / windowMs)}`, windowMs);
    const retryAfterS = Math.max(1, this.windowS - Math.floor((Date.now() % windowMs) / 1000));
    return { allowed: count <= limit, retryAfterS };
  }
}

/** Caps simultaneous work per key (connections per client, requests towards the plugin). */
export class Gate {
  private readonly active = new Map<string, number>();

  constructor(private readonly max: number) {}

  enter(key: string): boolean {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return false;
    this.active.set(key, n + 1);
    return true;
  }

  leave(key: string): void {
    const n = (this.active.get(key) ?? 1) - 1;
    if (n <= 0) this.active.delete(key);
    else this.active.set(key, n);
  }
}
