/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Clients remembered by one `FillBudget` before the coldest one is dropped; the map must stay bounded itself. */
const MAX_CLIENTS = 10_000;

/**
 * Caps how many distinct cache keys one client may cause to be stored in a window (cache-fill protection).
 *
 * Every new cache key costs the plugin work and shared memory: ids, offsets and combinations of query parameters are
 * validated but not enumerable, so a single client could otherwise add entries without bound. Reads are free and never
 * limited; only the first store of a key counts, and a key this client already stored stays usable until it expires.
 * The budget is per proxy node, like the concurrency gates.
 */
export class FillBudget {
  private readonly clients = new Map<string, Map<string, number>>();

  constructor(private readonly maxKeys: number, private readonly windowMs: number, private readonly maxClients = MAX_CLIENTS) {}

  /** Records `key` against `client`; false when that client already filled its budget for the window. */
  allow(client: string, key: string, now = Date.now()): boolean {
    let keys = this.clients.get(client);
    if (!keys) {
      if (this.clients.size >= this.maxClients) this.clients.delete(this.clients.keys().next().value as string);
      keys = new Map();
      this.clients.set(client, keys);
    }
    for (const [k, until] of keys) if (until <= now) keys.delete(k);
    if (keys.has(key)) return true;
    if (keys.size >= this.maxKeys) return false;
    keys.set(key, now + this.windowMs);
    return true;
  }
}
