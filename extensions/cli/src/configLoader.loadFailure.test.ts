import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  continueHome: "",
}));

vi.mock("./env.js", () => ({ env: mockEnv }));
vi.mock("./auth/workos.js", () => ({
  getAccessToken: () => null,
  getOrganizationId: () => null,
  updateConfigUri: vi.fn(),
}));

import {
  configLoadFailure,
  ConfigLoadError,
  loadConfiguration,
} from "./configLoader.js";

describe("a config.yaml that does not load", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-config-fail-"));
    mockEnv.continueHome = home;
    file = path.join(home, "broken.yaml");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function failure(text: string): Promise<string> {
    fs.writeFileSync(file, text);
    const error = await loadConfiguration({} as any, file, [], true).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  it("malformed YAML: the file and the position, not the file's lines", async () => {
    const message = await failure(
      [
        "name: Broken",
        "version: 1.0.0",
        "schema: v1",
        "models:",
        "  - name: m",
        "    provider: anthropic",
        "    apiKey: sk-ant-SECRETSECRET: oops: [",
        "",
      ].join("\n"),
    );
    expect(message).toContain(file);
    expect(message).toMatch(/line \d+, column \d+/);
    expect(message).not.toContain("SECRETSECRET");
    expect(message).not.toContain("[object Object]");
  });

  it("a config of the wrong shape: the reason as text", async () => {
    const message = await failure("name: 5\nmodels: nope\n");
    expect(message).toContain(file);
    expect(message).not.toContain("[object Object]");
    expect(message.length).toBeGreaterThan(
      `Failed to load config ${file}: `.length,
    );
  });
});

describe("ConfigLoadError", () => {
  it("carries the reason without the file, for a caller that names the file", () => {
    const error = new ConfigLoadError("c.yaml", ["name: Required"]);
    expect(error.message).toBe("Failed to load config c.yaml: name: Required");
    expect(error.reason).toBe("name: Required");
  });
});

describe("configLoadFailure", () => {
  it("never prints an object", () => {
    const errors = [
      { fatal: true, message: "models.0.provider: Required" },
      { fatal: false, message: "rules.2: Expected string" },
    ];
    const message = configLoadFailure(
      "/home/me/.continuous/config.yaml",
      errors.map((e) => e.message),
    );
    expect(message).toBe(
      "Failed to load config /home/me/.continuous/config.yaml:\n- models.0.provider: Required\n- rules.2: Expected string",
    );
  });

  it("puts a single problem on one line", () => {
    expect(configLoadFailure("c.yaml", ["name: Required"])).toBe(
      "Failed to load config c.yaml: name: Required",
    );
  });

  it("drops the source lines a YAML parser quotes", () => {
    const yamlMessage =
      "Failed to parse config: Nested mappings are not allowed in compact mappings at line 7, column 13:\n\n    apiKey: sk-ant-SECRET: oops\n            ^^^^^^^^^^^^^^^^^^^^\n";
    expect(configLoadFailure("c.yaml", [yamlMessage])).toBe(
      "Failed to load config c.yaml: Failed to parse config: Nested mappings are not allowed in compact mappings at line 7, column 13",
    );
  });

  it("says so when no reason was given", () => {
    expect(configLoadFailure(undefined, [])).toBe(
      "Failed to load config: no reason was given.",
    );
  });
});
