import { describe, expect, it } from "vitest";
import {
  allowReading,
  matchTerminalCommand,
  parseToolPermissions,
} from "./rules";

const rules = parseToolPermissions({
  allow: ["runTerminalCommand(npm test*)", "runTerminalCommand(git status)"],
  deny: ["runTerminalCommand(git push*)"],
});

describe("an allow rule and a shell that is not known", () => {
  it("covers the command in the shells this product parses", () => {
    for (const shell of ["bash", "zsh", "sh", "powershell", "cmd"] as const) {
      expect(matchTerminalCommand(rules, "npm test", shell)?.decision).toBe(
        "allow",
      );
    }
  });

  it("does not cover it when the shell is unknown: the call asks", () => {
    // fish, nushell, ksh, or a remote window's terminal
    expect(allowReading("npm test", "unknown")).toEqual({ ok: false });
    expect(matchTerminalCommand(rules, "npm test", "unknown")).toBeUndefined();
    expect(
      matchTerminalCommand(rules, "git status", "unknown"),
    ).toBeUndefined();
  });

  it("still denies under an unknown shell", () => {
    expect(
      matchTerminalCommand(rules, "git push origin main", "unknown")?.decision,
    ).toBe("deny");
    expect(
      matchTerminalCommand(rules, "bash -c 'git push'", "unknown")?.decision,
    ).toBe("deny");
  });

  it("leaves a caller that names no shell as it was", () => {
    expect(matchTerminalCommand(rules, "npm test")?.decision).toBe("allow");
  });
});
