import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// At IDGAF every call runs; these tests read what the guard would have
// decided (wouldDecide), which IDGAF records instead of acting on.
const evaluateToolPolicyWithRules = (
  input: Parameters<typeof evaluateAndRun>[0],
) => wouldDecide(evaluateAndRun(input));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { evaluateToolPolicyWithRules as evaluateAndRun } from "./evaluate";
import { wouldDecide } from "./idgafView.testutil";
import { DEFAULT_POLICY_LEVELS } from "./policy";
import {
  clearUserEnvNamesCache,
  readUserEnvNames,
  sanitizeEnvNames,
} from "./userEnvNames";
import { stripUntrustedLoosening } from "./trust";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "envnames-"));
  file = path.join(dir, "config.yaml");
  clearUserEnvNamesCache();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const YAML_TEXT = `name: x
toolPermissions:
  auto:
    environment:
      envNames:
        ask: [ FOO_*, " BAR " ]
        allow: [ HTTP_PROXY ]
`;

describe("readUserEnvNames", () => {
  it("reads ask and allow from the user's config.yaml", () => {
    fs.writeFileSync(file, YAML_TEXT);
    expect(readUserEnvNames(file)).toEqual({
      ask: ["FOO_*", "BAR"],
      allow: ["HTTP_PROXY"],
    });
  });

  it("gives undefined for a missing, broken or empty file", () => {
    expect(readUserEnvNames(file)).toBeUndefined();
    fs.writeFileSync(file, "toolPermissions: [unclosed");
    expect(readUserEnvNames(file)).toBeUndefined();
    fs.writeFileSync(
      file,
      "toolPermissions:\n  auto:\n    environment:\n      envNames: 5\n",
    );
    expect(readUserEnvNames(file)).toBeUndefined();
  });

  it("drops entries that are not text", () => {
    expect(sanitizeEnvNames({ ask: ["A", 3, null], allow: "B" })).toEqual({
      ask: ["A"],
    });
  });

  it("does not read the file again while it is unchanged", () => {
    fs.writeFileSync(file, YAML_TEXT);
    vi.mocked(fs.readFileSync).mockClear();
    readUserEnvNames(file);
    readUserEnvNames(file);
    readUserEnvNames(file);
    const reads = vi
      .mocked(fs.readFileSync)
      .mock.calls.filter((c) => c[0] === file);
    expect(reads).toHaveLength(1);
  });

  it("reads again after the file changes", () => {
    fs.writeFileSync(file, YAML_TEXT);
    expect(readUserEnvNames(file)?.ask).toEqual(["FOO_*", "BAR"]);
    fs.writeFileSync(
      file,
      "toolPermissions:\n  auto:\n    environment:\n      envNames:\n        ask: [ZED]\n  # padding so the size differs\n",
    );
    expect(readUserEnvNames(file)?.ask).toEqual(["ZED"]);
    fs.rmSync(file);
    expect(readUserEnvNames(file)).toBeUndefined();
  });

  it("is only ever read from the file it is given: a workspace or assistant list is never an input", () => {
    // the workspace file sits beside, in another place, and is not the user's config
    const workspace = path.join(dir, "workspace.yaml");
    fs.writeFileSync(workspace, YAML_TEXT);
    fs.writeFileSync(file, "name: mine\n");
    expect(readUserEnvNames(file)).toBeUndefined();
    // and a repository file's allow key is stripped before the config merges
    const stripped = stripUntrustedLoosening({
      toolPermissions: {
        auto: { environment: { envNames: { allow: ["PATH"], ask: ["X"] } } },
      },
    });
    expect(stripped.removed).toContain(
      "toolPermissions.auto.environment.envNames.allow",
    );
  });
});

const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};

const allLevels = {
  ...DEFAULT_POLICY_LEVELS,
  context: "idgaf",
  tools: "idgaf",
  edits: "idgaf",
} as any;

function decide(command: string, envNames: any) {
  return evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: "allowedWithoutPermission",
    parsedArgs: { command },
    permissions: undefined,
    shell: "bash",
    // IDGAF: only a name that is dangerous asks here
    approval: { levels: allLevels },
    envNames,
  }).policy;
}

describe("the lists change the decision, within the floor", () => {
  it("an ask entry makes a harmless-looking name ask", () => {
    expect(decide("FOO_X=1 ls", undefined)).toBe("allowedWithoutPermission");
    expect(decide("FOO_X=1 ls", { ask: ["FOO_*"] })).toBe(
      "allowedWithPermission",
    );
  });

  it("an allow entry cannot loosen a name that is dangerous by default", () => {
    expect(decide("LD_PRELOAD=/x.so ls", undefined)).toBe(
      "allowedWithPermission",
    );
    expect(decide("LD_PRELOAD=/x.so ls", { allow: ["LD_PRELOAD"] })).toBe(
      "allowedWithPermission",
    );
    expect(decide("PATH=/x ls", { allow: ["PATH", "*"] })).toBe(
      "allowedWithPermission",
    );
  });
});
