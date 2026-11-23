/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import { ANONYMOUS, withPlayer } from "../src/scope.js";

describe("cache scope", () => {
  it("scopes a typed player name like an identity, so player-names answers can be cached per player", () => {
    expect(withPlayer(ANONYMOUS, "steve")).toEqual({ key: "n:steve", kind: "player" });
  });

  it("leaves anonymous requests without a name and token scopes untouched", () => {
    expect(withPlayer(ANONYMOUS, "")).toBe(ANONYMOUS);
    const token = { key: "t:hash", kind: "unverified" as const };
    expect(withPlayer(token, "steve")).toBe(token);
  });
});
