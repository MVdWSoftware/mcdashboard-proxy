/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { FillBudget } from "../src/budget.js";

describe("cache-fill budget", () => {
  const now = 1_000_000;

  it("lets a client store a key once and keeps it usable", () => {
    const b = new FillBudget(2, 1000);
    expect(b.allow("a", "k1", now)).toBe(true);
    expect(b.allow("a", "k1", now + 10)).toBe(true);
    expect(b.allow("a", "k2", now)).toBe(true);
    expect(b.allow("a", "k3", now)).toBe(false);
    // Another client has its own budget.
    expect(b.allow("b", "k3", now)).toBe(true);
  });

  it("frees the budget when the window passed", () => {
    const b = new FillBudget(1, 1000);
    expect(b.allow("a", "k1", now)).toBe(true);
    expect(b.allow("a", "k2", now + 500)).toBe(false);
    expect(b.allow("a", "k2", now + 1000)).toBe(true);
  });

  it("stays bounded itself: the coldest client is forgotten", () => {
    const b = new FillBudget(1, 1000, 2);
    expect(b.allow("a", "k1", now)).toBe(true);
    expect(b.allow("b", "k1", now)).toBe(true);
    expect(b.allow("c", "k1", now)).toBe(true); // evicts "a"
    expect(b.allow("a", "k2", now)).toBe(true); // forgotten, so it starts again
  });
});
