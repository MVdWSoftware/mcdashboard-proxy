/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { match } from "../src/routes.js";

// openapi.yaml of the MCDashboard-plugin repository: MCD_OPENAPI (CI), else a sibling checkout. Skipped only when
// neither is there; a wrong MCD_OPENAPI fails instead of silently skipping.
const file = process.env.MCD_OPENAPI ?? "../MCDashboard-plugin/openapi.yaml";

describe.skipIf(!process.env.MCD_OPENAPI && !existsSync(file))("OpenAPI contract", () => {
  const operations = () => {
    let path = "";
    const ops: { method: string; url: string; internal: boolean }[] = [];
    let inPaths = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\S/.test(line)) inPaths = line.startsWith("paths:");
      if (!inPaths) continue;
      const p = /^  (\/\S+):\s*$/.exec(line);
      if (p) path = p[1]!;
      const o = /^    (get|post|put|delete|patch):\s*$/.exec(line);
      if (o && path) ops.push({ method: o[1]!.toUpperCase(), url: "/v1" + path.replace(/\{[^}]+\}/g, "sample"), internal: false });
      if (/^      x-internal:\s*true\s*$/.test(line) && ops.length) ops[ops.length - 1]!.internal = true;
    }
    return ops;
  };
  const kind = (method: string, url: string) => {
    const u = new URL(url + (url.endsWith("/values") ? "?ids=a" : ""), "http://x");
    return match(method, u.pathname, u.searchParams).kind;
  };

  it("every public operation of the contract is routed by the proxy", () => {
    const ops = operations().filter((o) => !o.internal);
    expect(ops.length).toBeGreaterThan(8);
    for (const o of ops) expect(kind(o.method, o.url), `${o.method} ${o.url}`).toBe("route");
  });

  it("internal operations (the plugin's event stream) are never exposed", () => {
    const internal = operations().filter((o) => o.internal);
    expect(internal.map((o) => o.url)).toContain("/v1/events");
    for (const o of internal) expect(kind(o.method, o.url), `${o.method} ${o.url}`).toBe("notFound");
  });
});
