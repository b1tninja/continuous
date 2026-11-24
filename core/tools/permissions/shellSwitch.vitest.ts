import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLintGate, resetCommandLintGate } from "./commandLint";
import { builtinSwitchOff } from "./secretSwitch";

let dir: string;

vi.mock("../../util/paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../util/paths")>();
  return { ...real, getContinueGlobalPath: () => dir };
});

// What the terminal tool passes: the switch as the file says it now. The check
// is opt-in, so it runs only when the file turns it on.
const gate = (command: string, shell: "powershell") =>
  commandLintGate(
    command,
    shell,
    process.env,
    !builtinSwitchOff("check-shell-commands"),
  );

const file = () => path.join(dir, "permissions.yaml");
const write = (text: string) => fs.writeFileSync(file(), text);

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
  it("runs a command as written while the switch is not set", () => {
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeUndefined();
  });

  it("stops a command the shell would reject once the switch is turned on", () => {
    write("builtin:\n  check-shell-commands: true\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeDefined();
  });

  it("runs it as written again when the switch is turned back off", () => {
    write("builtin:\n  check-shell-commands: true\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeDefined();
    write("builtin:\n  check-shell-commands: false\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeUndefined();
  });

  it("is not turned on by other switches being named", () => {
    write("builtin:\n  protect-secrets: false\n");
    expect(gate(BASH_IN_POWERSHELL, "powershell")).toBeUndefined();
  });
});
