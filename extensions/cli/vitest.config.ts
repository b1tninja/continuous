import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Removes provider credentials unless RUN_LIVE_PROVIDER_TESTS=1 (src/test-helpers/liveProviderGuard.ts).
    globalSetup: ["./vitest.live-provider-guard.global.ts"],
    setupFiles: [
      "./vitest.live-provider-guard.ts",
      "./vitest.global-dir-setup.ts",
      "./vitest.setup.ts",
    ],
    // src/smoke-api calls a paid API: only vitest.smoke-api.config.ts runs it.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.e2e.*",
      "**/e2e/**",
      "src/smoke-api/**",
    ],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/test-helpers/**",
        "**/types/**",
        "**/__mocks__/**",
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, "src"),
    },
    extensions: [".js", ".ts", ".tsx", ".json"],
  },
});
