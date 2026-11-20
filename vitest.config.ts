/*
 * Copyright (c) 2026 MVdW-Software
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The process entrypoint only wires config, signals and listen(); everything it calls is tested.
      exclude: ["src/index.ts"],
      reporter: ["text", "cobertura", "lcov", "html"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
