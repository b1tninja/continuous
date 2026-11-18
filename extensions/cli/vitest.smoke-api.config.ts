import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Not vitest.setup.ts: it mocks global.fetch, which breaks real API calls. The guard
    // keeps credentials only when RUN_SMOKE_API=1 or RUN_LIVE_PROVIDER_TESTS=1
    // (src/test-helpers/liveProviderGuard.ts).
    globalSetup: ["./vitest.live-provider-guard.global.ts"],
    setupFiles: ["./vitest.live-provider-guard.ts"],
    include: ["src/smoke-api/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    retry: 2,
    // Run sequentially to avoid rate-limiting from real API calls
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, "src"),
    },
    extensions: [".js", ".ts", ".tsx", ".json"],
  },
});
