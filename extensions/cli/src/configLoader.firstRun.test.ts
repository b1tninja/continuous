import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  continueHome: "",
}));
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("./env.js", () => ({ env: mockEnv }));
vi.mock("./auth/workos.js", () => ({
  getAccessToken: () => auth.token,
  getOrganizationId: () => null,
  updateConfigUri: vi.fn(),
}));

import { loadConfiguration } from "./configLoader.js";

describe("first run with no config.yaml", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-firstrun-"));
    mockEnv.continueHome = home;
    auth.token = null;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses an empty local assistant", async () => {
    const result = await loadConfiguration({} as any, undefined, [], true);
    expect(result.source.type).toBe("no-config");
  });

  it.each([["signed in", () => (auth.token = "token")]])(
    "still uses an empty local assistant when %s",
    async (_n, setup) => {
      setup();
      const result = await loadConfiguration({} as any, undefined, [], true);
      expect(result.source.type).toBe("no-config");
    },
  );

  it("uses a local config.yaml", async () => {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      "name: Local\nversion: 1.0.0\nschema: v1\n",
    );
    const result = await loadConfiguration({} as any, undefined, [], true);
    expect(result.source.type).toBe("local-config-yaml");
  });

  it("rejects a hub assistant slug with a clear error", async () => {
    await expect(
      loadConfiguration({} as any, "owner/slug", [], true),
    ).rejects.toThrow(
      "hub assistants are not supported; pass a config.yaml path",
    );
  });
});
