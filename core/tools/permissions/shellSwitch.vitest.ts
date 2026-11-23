import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../util/paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../util/paths")>();
  return { ...real, getContinueGlobalPath: () => dir };
});

const { commandLintGate, resetCommandLintGate } = await import("./commandLint");
const { builtinSwitchOff } = await import("./secretSwitch");

// What the terminal tool passes: the switch as the file says it now
const gate = (command: string, shell: "powershell") =>
  commandLintGate(
    command,
    shell,
    process.env,
    !builtinSwitchOff("check-shell-commands"),
  );

const file = () => path.join(dir, "permissions.yaml");

// Bash in PowerShell: an error the lint stops
const BASH_IN_POWERSHELL = "export FOO=1 && echo $FOO";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-switch-"));
  resetCommandLintGate();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Check shell commands switch", () => {
  it("stops a command the shell would reject while the switch is on", () => {
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeDefined();
  });

  it("lets the same command run as written once the switch is off", () => {
    fs.writeFileSync(file(), "builtin:\n  check-shell-commands: false\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeUndefined();
  });

  it("is on again when the file sets it back on", () => {
    fs.writeFileSync(file(), "builtin:\n  check-shell-commands: false\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeUndefined();
    fs.writeFileSync(file(), "builtin:\n  check-shell-commands: true\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeDefined();
  });
});
