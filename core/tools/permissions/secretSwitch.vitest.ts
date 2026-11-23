import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSecurityConcern } from "../../indexing/ignore";
import { secretSwitchOff } from "./secretSwitch";

let dir: string;

vi.mock("../../util/paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../util/paths")>();
  return { ...real, getContinueGlobalPath: () => dir };
});

const file = () => path.join(dir, "permissions.yaml");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-switch-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Commands and secrets switch in the secret-file filter", () => {
  it("is on when there is no permissions file", () => {
    expect(secretSwitchOff()).toBe(false);
    expect(isSecurityConcern(".env", dir)).toBe(true);
  });

  it("is on when the key is absent", () => {
    fs.writeFileSync(file(), "levels:\n  tools: cautious\n");
    expect(secretSwitchOff()).toBe(false);
    expect(isSecurityConcern(".env", dir)).toBe(true);
  });

  it("is off when protect-secrets is false, and the secret file is then allowed", () => {
    fs.writeFileSync(file(), "builtin:\n  protect-secrets: false\n");
    expect(secretSwitchOff()).toBe(true);
    expect(isSecurityConcern(".env", dir)).toBe(false);
    expect(isSecurityConcern("config/credentials.json", dir)).toBe(false);
  });

  it("still refuses a relative path that leaves the workspace", () => {
    fs.writeFileSync(file(), "builtin:\n  protect-secrets: false\n");
    expect(isSecurityConcern("../outside.txt", dir)).toBe(true);
  });

  it("picks up a change to the file without a restart", () => {
    fs.writeFileSync(file(), "builtin:\n  protect-secrets: false\n");
    expect(isSecurityConcern(".env", dir)).toBe(false);
    fs.writeFileSync(file(), "builtin:\n  protect-secrets: true\n");
    expect(isSecurityConcern(".env", dir)).toBe(true);
  });
});
