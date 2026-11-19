/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

/** Addresses and CIDRs from a comma separated setting; `name` only appears in the startup error. */
export class AddressList {
  private readonly list = new BlockList();
  readonly empty: boolean;

  constructor(entries: string[], name: string) {
    this.empty = entries.length === 0;
    for (const e of entries) {
      const [addr = "", bits] = e.split("/");
      const family = isIP(addr);
      if (!family) throw new Error(`${name}: invalid address ${e}`);
      const type = family === 6 ? "ipv6" : "ipv4";
      if (bits === undefined) this.list.addAddress(addr, type);
      else this.list.addSubnet(addr, Number(bits), type);
    }
  }

  has(ip: string): boolean {
    const fam = isIP(ip);
    return fam !== 0 && this.list.check(ip, fam === 6 ? "ipv6" : "ipv4");
  }
}

/** Resolves the real client address; X-Forwarded-For is only believed from trusted peers. */
export class ClientIp {
  private readonly trusted: AddressList;

  constructor(entries: string[]) {
    this.trusted = new AddressList(entries, "TRUSTED_PROXIES");
  }

  of(req: IncomingMessage): string {
    const xff = req.headers["x-forwarded-for"];
    return this.resolve(req.socket.remoteAddress ?? "", Array.isArray(xff) ? xff.join(",") : xff);
  }

  /** Walks X-Forwarded-For from the right, skipping trusted proxies; the first other hop is the client. */
  resolve(peer: string, forwardedFor: string | undefined): string {
    let ip = normalize(peer);
    if (!forwardedFor || !this.trusted.has(ip)) return ip;
    const hops = forwardedFor.split(",").map((h) => normalize(h.trim())).filter((h) => isIP(h) !== 0);
    for (let i = hops.length - 1; i >= 0; i--) {
      ip = hops[i]!;
      if (!this.trusted.has(ip)) break;
    }
    return ip;
  }
}

function normalize(ip: string): string {
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/** Rate-limit bucket: an IPv4 address, or the /64 of an IPv6 address (a single host owns a whole /64). */
export function bucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  return expandV6(ip).slice(0, 4).join(":") + "::/64";
}

function expandV6(ip: string): string[] {
  const [head = "", tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""));
}
