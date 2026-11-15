import net from "node:net";
import { describe, expect, it } from "vitest";

import { liveProviderTestsEnabled } from "./liveProviderGuard";

// The guard is off when live provider tests run (CI sets RUN_LIVE_PROVIDER_TESTS=1), so its test is too
describe.skipIf(liveProviderTestsEnabled())(
  "the metadata-server guard (test/noMetadataServer.setup.ts)",
  () => {
    it("refuses a socket to the cloud metadata address", () => {
      const socket = new net.Socket();
      expect(() => socket.connect(80, "169.254.169.254")).toThrow(
        /cloud metadata server/,
      );
      expect(() =>
        socket.connect({ host: "metadata.google.internal", port: 80 }),
      ).toThrow(/cloud metadata server/);
      socket.destroy();
      // Taken here, so the guard's afterEach does not fail this test
      const seen = (globalThis as any)[
        Symbol.for("continuous.test.metadataAttempts")
      ].splice(0);
      expect(seen).toEqual(["169.254.169.254", "metadata.google.internal"]);
    });

    it("tells gcp-metadata not to look for the server", () => {
      expect(process.env.METADATA_SERVER_DETECTION).toBe("none");
    });
  },
);
