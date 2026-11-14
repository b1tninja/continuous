import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { commandCandidates } from "./candidates";
import { protectedCommandHit } from "./protectedCall";
import { matchTerminalCommand, parseToolPermissions } from "./rules";
import { policyFileHit } from "./selfProtect";

/**
 * PowerShell reads curly quotes as quotes, en and em dashes as `-` and any
 * Unicode space as a space (checked with `powershell.exe -Command`). A deny
 * rule, an ask rule and the path guards must meet the command PowerShell runs.
 */
const LDQ = "\u201c";
const RDQ = "\u201d";
const LSQ = "\u2018";
const RSQ = "\u2019";
const HOME = "C:/Users/me";

const rules = parseToolPermissions({
  deny: ["runTerminalCommand(git push*)"],
  ask: ["runTerminalCommand(Remove-Item -Recurse*)"],
});
const decide = (command: string, shell?: ShellKind) =>
  matchTerminalCommand(rules, command, shell)?.decision ?? "none";

describe("curly quotes, dashes and spaces PowerShell reads as ASCII", () => {
  it.each<[string, ShellKind | undefined]>([
    [`git ${LDQ}push${RDQ} origin`, "powershell"],
    [`git ${LSQ}push${RSQ}`, "powershell"],
    [`${LDQ}git${RDQ} push`, "powershell"],
    ["git\u2003push", "powershell"],
    // No shell given: every grammar is read
    [`git ${LDQ}push${RDQ} origin`, undefined],
    [`git ${LDQ}push${RDQ} origin`, "unknown"],
  ])("a deny rule meets %j (%s)", (command, shell) => {
    expect(decide(command, shell)).toBe("deny");
  });

  it("an ask rule meets a parameter written with an en dash", () => {
    expect(decide("Remove-Item \u2013Recurse x", "powershell")).toBe("ask");
    expect(decide("Remove-Item \u2014Recurse x", "powershell")).toBe("ask");
  });

  it("a secret path in curly quotes is still a secret path", () => {
    const hit = protectedCommandHit(
      `Get-Content ${LDQ}C:\\Users\\me\\.ssh\\id_rsa${RDQ}`,
      HOME,
      [],
      "C:/work",
      "powershell",
    );
    expect(hit?.kind).toBe("secret");
  });

  it("a policy file in curly quotes is still a policy file", () => {
    const hit = policyFileHit({
      toolName: "run_terminal_command",
      parsedArgs: {
        command: `Set-Content ${LSQ}C:\\Users\\me\\.continue\\config.yaml${RSQ} x`,
      },
      home: HOME,
      cwd: "C:/work",
      shell: "powershell",
    });
    expect(hit).toBeDefined();
  });

  it("a POSIX shell keeps them as ordinary characters", () => {
    // In bash this runs git with the argument “push”, which is not a push
    expect(decide(`git ${LDQ}push${RDQ}`, "bash")).toBe("none");
    expect(commandCandidates(`git ${LDQ}push${RDQ}`, "bash")).not.toContain(
      "git push",
    );
  });

  it("does not match a command that is not the denied one", () => {
    expect(decide(`git ${LDQ}status${RDQ}`, "powershell")).toBe("none");
    expect(decide("git status", "powershell")).toBe("none");
  });
});
