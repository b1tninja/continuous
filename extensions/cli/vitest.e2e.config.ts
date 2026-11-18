import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Removes provider credentials unless RUN_LIVE_PROVIDER_TESTS=1 (src/test-helpers/liveProviderGuard.ts).
    globalSetup: ["./vitest.live-provider-guard.global.ts"],
    setupFiles: ["./vitest.live-provider-guard.ts", "./vitest.setup.ts"],
    include: ["src/e2e/**/*.test.ts"],
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
