import * as fs from "node:fs";
import * as path from "node:path";

import { FQSN, SecretType } from "@continuedev/config-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIPlatformClient } from "./CLIPlatformClient.js";

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock env module
vi.mock("./env.js", () => ({
  env: {
    continueHome: "/home/user/.continue",
  },
}));

const fqsnFor = (secretName: string): FQSN => ({
  packageSlugs: [{ ownerSlug: "anthropic", packageSlug: "claude-sonnet" }],
  secretName,
});

describe("CLIPlatformClient", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe("resolveFQSNs", () => {
    it("returns empty array for empty input", async () => {
      const results = await new CLIPlatformClient().resolveFQSNs([]);
      expect(results).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("resolves from process.env", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "local-api-key");

      const results = await new CLIPlatformClient().resolveFQSNs([
        fqsnFor("ANTHROPIC_API_KEY"),
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        found: true,
        value: "local-api-key",
        secretLocation: {
          secretType: SecretType.LocalEnv,
          secretName: "ANTHROPIC_API_KEY",
        },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("resolves a file-based FQSN (empty package slugs) from process.env", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "my-local-api-key");
      const fqsn: FQSN = {
        packageSlugs: [{ ownerSlug: "", packageSlug: "" }],
        secretName: "ANTHROPIC_API_KEY",
      };

      const results = await new CLIPlatformClient().resolveFQSNs([fqsn]);

      expect(results[0]).toMatchObject({
        found: true,
        value: "my-local-api-key",
        fqsn,
      });
    });

    it("resolves from a local .env file", async () => {
      vi.stubEnv("FILE_ONLY_SECRET", undefined as unknown as string);
      vi.mocked(fs.existsSync).mockImplementation(
        (p) => String(p) === path.join("/home/user/.continue", ".env"),
      );
      vi.mocked(fs.readFileSync).mockReturnValue(
        "FILE_ONLY_SECRET=from-file\n",
      );

      const results = await new CLIPlatformClient().resolveFQSNs([
        fqsnFor("FILE_ONLY_SECRET"),
      ]);

      expect(results[0]).toMatchObject({ found: true, value: "from-file" });
    });

    it("leaves unresolved secrets undefined and names them in a local warning", async () => {
      vi.stubEnv("FOUND_KEY", "v1");
      vi.stubEnv("MISSING_KEY", undefined as unknown as string);

      const results = await new CLIPlatformClient().resolveFQSNs([
        fqsnFor("FOUND_KEY"),
        fqsnFor("MISSING_KEY"),
      ]);

      expect(results[0]).toMatchObject({ found: true, value: "v1" });
      expect(results[1]).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("MISSING_KEY");
      expect(message).not.toContain("FOUND_KEY");
      expect(message).not.toContain("v1");
      expect(message).toContain("never fetched from a server");
    });
  });
});
