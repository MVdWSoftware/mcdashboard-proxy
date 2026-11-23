/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * The proxy exposes exactly the routes of the MCDashboard OpenAPI contract
 * (openapi.yaml in the MCDashboard-plugin repository). Everything else is answered
 * locally and never reaches the Minecraft server.
 */
export type RateClass = "read" | "auth" | "write";

export interface Route {
  name: string;
  rate: RateClass;
  cacheable: boolean;
  hasBody: boolean;
}

export type Match =
  | { kind: "route"; route: Route }
  | { kind: "notFound" }
  | { kind: "methodNotAllowed"; allow: string[] }
  | { kind: "badRequest"; message: string };

const PLACEHOLDER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const DASHBOARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface Def {
  pattern: RegExp;
  methods: Record<string, Route>;
  query?: Record<string, (v: string) => string | null>;
  param?: (v: string) => boolean;
  /**
   * Whether this request may be cached. Validated parameters can still be unbounded in combination: free-text searches
   * (`q`, `group`), history windows (`since`, `points`) and id subsets would each add keys without end, so those are
   * forwarded but never stored.
   */
  cacheWhen?: (params: URLSearchParams) => boolean;
}

const read = (name: string): Route => ({ name, rate: "read", cacheable: true, hasBody: false });

const ids = (max: number) => (v: string): string | null => {
  const list = v === "" ? [] : v.split(",");
  if (list.length < 1 || list.length > max) return `ids must list 1-${max} placeholder ids`;
  return list.every((i) => PLACEHOLDER_ID.test(i)) ? null : "ids contains an invalid placeholder id";
};
const num = (min: number, max: number, what: string) => (v: string): string | null =>
  /^\d{1,10}$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `${what} must be ${min}-${max}`;
const text = (max: number, what: string) => (v: string): string | null => (v.length <= max ? null : `${what} is too long`);

/** The plugin's list view: `ids` is a bounded batch lookup, free-text search and paging are not cached. */
const listCacheable = (params: URLSearchParams): boolean => !params.has("q") && !params.has("group");

/** The history route: a window (`since`, `points`) is a new answer every time, so only the default window is cached. */
const historyCacheable = (params: URLSearchParams): boolean => !params.has("since") && !params.has("points");

const DEFS: Def[] = [
  { pattern: /^\/v1\/info$/, methods: { GET: read("info") } },
  { pattern: /^\/v1\/auth$/, methods: { POST: { name: "auth", rate: "auth", cacheable: false, hasBody: true } } },
  { pattern: /^\/v1\/auth\/refresh$/, methods: { POST: { name: "refresh", rate: "auth", cacheable: false, hasBody: true } } },
  {
    pattern: /^\/v1\/placeholders$/,
    methods: { GET: read("placeholders") },
    query: {
      q: text(64, "q"),
      group: text(64, "group"),
      limit: num(1, 100, "limit"),
      offset: num(0, 1_000_000, "offset"),
      ids: (v) => (v === "" ? null : ids(100)(v)),
    },
    cacheWhen: listCacheable,
  },
  { pattern: /^\/v1\/placeholders\/([^/]+)$/, methods: { GET: read("placeholder") }, param: (v) => PLACEHOLDER_ID.test(v) },
  { pattern: /^\/v1\/values$/, methods: { GET: read("values") }, query: { ids: ids(100) } },
  {
    pattern: /^\/v1\/history\/([^/]+)$/,
    methods: { GET: read("history") },
    param: (v) => PLACEHOLDER_ID.test(v),
    query: { since: num(0, 4_102_444_800, "since"), points: num(2, 2000, "points") },
    cacheWhen: historyCacheable,
  },
  {
    pattern: /^\/v1\/dashboards$/,
    methods: { GET: read("dashboards"), POST: { name: "dashboardUpload", rate: "write", cacheable: false, hasBody: true } },
  },
  { pattern: /^\/v1\/dashboards\/([^/]+)$/, methods: { GET: read("dashboard") }, param: (v) => DASHBOARD_ID.test(v) },
  { pattern: /^\/v1\/dashboard$/, methods: { GET: read("dashboardLegacy") } },
  { pattern: /^\/v1\/devices\/self$/, methods: { DELETE: { name: "unpair", rate: "write", cacheable: false, hasBody: false } } },
];

export function match(method: string, path: string, params: URLSearchParams): Match {
  for (const def of DEFS) {
    const m = def.pattern.exec(path);
    if (!m) continue;
    const route = def.methods[method === "HEAD" ? "GET" : method];
    if (!route) return { kind: "methodNotAllowed", allow: Object.keys(def.methods) };
    if (def.param && !def.param(m[1] as string)) return { kind: "notFound" };
    const seen = new Set<string>();
    for (const [k, v] of params) {
      const check = def.query?.[k];
      if (!check || seen.has(k)) return { kind: "badRequest", message: `unexpected query parameter ${k}` };
      seen.add(k);
      const err = check(v);
      if (err) return { kind: "badRequest", message: err };
    }
    if (route.name === "values" && !seen.has("ids")) return { kind: "badRequest", message: "ids must list 1-100 placeholder ids" };
    if (def.cacheWhen && !def.cacheWhen(params)) return { kind: "route", route: { ...route, cacheable: false } };
    return { kind: "route", route };
  }
  return { kind: "notFound" };
}

/** Canonical cache key part: parameters sorted, and /values ids sorted like the plugin does. */
export function canonicalQuery(params: URLSearchParams): string {
  const p = new URLSearchParams(params);
  const idList = p.get("ids");
  // Explicit code-point comparator (typescript:S2871): same order as the plugin and as bare sort() produced.
  if (idList) p.set("ids", idList.split(",").sort((a, b) => Number(a > b) - Number(a < b)).join(","));
  const entries = [...p].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

/**
 * Accept-Language reduced to the languages the server has, in preference order, so the number of
 * cache variants stays small and a client cannot fill the cache with arbitrary header values.
 */
export function canonicalLanguages(header: string | undefined, supported: string[]): string {
  if (!header) return "";
  const tags = header.split(",").slice(0, 20).map((part, i) => {
    const [tag, ...ps] = part.trim().split(";") as [string, ...string[]];
    const q = ps.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
    return { lang: tag.trim().toLowerCase().split("-")[0] as string, q: q === undefined ? 1 : Number(q), i };
  });
  const out: string[] = [];
  for (const t of tags.filter((t) => t.q > 0).sort((a, b) => b.q - a.q || a.i - b.i)) {
    if (supported.includes(t.lang) && !out.includes(t.lang)) out.push(t.lang);
  }
  return out.join(",");
}
