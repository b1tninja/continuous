import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { POLICY_PRESETS, type PolicyLevels } from "./policy";
import { builtinForPreset } from "./safetyDegrees";

/**
 * IDGAF is a preset: Permissive on the areas, with every safety switch off.
 * Nothing reads the preset's name. Each check follows its own switch, so with
 * the switch off the call runs, and with it on the same levels still stop it.
 */
const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};
const fileTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any) => base,
};

const IDGAF: PolicyLevels = POLICY_PRESETS.idgaf.levels;
// Picking the preset sets the checks too: none of them is on
const NO_CHECKS = builtinForPreset("idgaf");

const command = (
  text: string,
  over: Partial<Parameters<typeof evaluateToolPolicyWithRules>[0]> = {},
) =>
  evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: ASK,
    parsedArgs: { command: text },
    permissions: undefined,
    shell: "bash",
    approval: { levels: IDGAF, builtin: NO_CHECKS },
    ...over,
  });

const write = (filepath: string, levels: PolicyLevels = IDGAF) =>
  evaluateToolPolicyWithRules({
    tool: fileTool as any,
    toolName: "create_new_file",
    basePolicy: ASK,
    parsedArgs: { filepath, contents: "x" },
    processedArgs: {
      resolvedPath: { uri: `file://${filepath}`, isWithinWorkspace: false },
    },
    permissions: undefined,
    approval: { levels, builtin: levels === IDGAF ? NO_CHECKS : undefined },
  });

describe("each check follows its own switch, whatever the levels are", () => {
  const withChecksOn = (floor?: string[]) => ({
    approval: { levels: IDGAF, ...(floor ? { floor } : {}) },
  });
  const CASES = [
    [
      "a floor rule",
      (checksOn: boolean) =>
        command("terraform destroy", {
          approval: {
            levels: IDGAF,
            ...(checksOn ? {} : { builtin: NO_CHECKS }),
            floor: ["runTerminalCommand(terraform destroy*)"],
          },
        }),
      OFF,
      "floor",
    ],
    [
      "the policy-file lock",
      (checksOn: boolean) =>
        evaluateToolPolicyWithRules({
          tool: fileTool as any,
          toolName: "create_new_file",
          basePolicy: ASK,
          parsedArgs: {
            filepath: "/home/me/.continue/config.yaml",
            contents: "x",
          },
          processedArgs: {
            resolvedPath: {
              uri: "file:///home/me/.continue/config.yaml",
              isWithinWorkspace: false,
            },
          },
          permissions: undefined,
          // Only this one switch differs: the rest of the preset stays off
          approval: {
            levels: IDGAF,
            builtin: checksOn
              ? { ...NO_CHECKS, "protect-policy-files": true }
              : NO_CHECKS,
          },
        }),
      // refused only at Automatic, where nobody can say yes; elsewhere it asks
      ASK,
      "floor",
    ],
    [
      "the run-time write lock (opt-in: ask-runtime-writes)",
      (checksOn: boolean) =>
        command("rm -rf $DIR", {
          approval: {
            levels: IDGAF,
            builtin: checksOn
              ? { ...NO_CHECKS, "ask-runtime-writes": true }
              : NO_CHECKS,
          },
        }),
      ASK,
      "floor",
    ],
    [
      "a deny rule (Never) in config.yaml",
      (checksOn: boolean) =>
        command("git push origin main", {
          permissions: { deny: ["runTerminalCommand(git push*)"] },
          ...(checksOn ? withChecksOn() : {}),
        }),
      OFF,
      "deny-rule",
    ],
  ] as const;

  it.each(CASES)(
    "%s: switched off, the call runs and nothing is recorded",
    (_name, decide) => {
      const r = decide(false);
      expect(r.policy).toBe(ALLOW);
      expect(r.source).toBe("permissive");
      // The check did not run, so there is nothing to record
      expect(r).not.toHaveProperty("idgafOverride");
    },
  );

  it.each(CASES)(
    "%s: switched on, the same levels still stop it",
    (_name, decide, stops, source) => {
      const r = decide(true);
      expect(r.policy).toBe(stops);
      expect(r.source).toBe(source);
    },
  );

  const CHECKS = [
    ["a command that hides what it runs", "G=rm; $G -rf ~", OFF],
    [
      "obfuscation the safety floor cannot see through",
      "rm${IFS}-rf${IFS}~",
      OFF,
    ],
    ["a protected secret file", "cat .env", ASK],
    ["the safety floor", "rm -rf /", OFF],
  ] as const;

  it.each(CHECKS)(
    "%s: with the IDGAF preset no check is on, so it runs and nothing objects",
    (_name, text) => {
      const r = command(text);
      expect(r.policy).toBe(ALLOW);
      expect(r.source).toBe("permissive");
      expect(r).not.toHaveProperty("idgafOverride");
    },
  );

  it.each(CHECKS)(
    "%s: Permissive with the checks left on still stops it",
    (_name, text, stops) => {
      const r = command(text, { approval: { levels: IDGAF } });
      expect(r.policy).toBe(stops);
    },
  );

  it("records nothing when nothing would have objected", () => {
    const r = command("npm test");
    expect(r.policy).toBe(ALLOW);
    expect(r).not.toHaveProperty("idgafOverride");
  });

  it("a tool the person switched off stays off (it is not offered at all)", () => {
    expect(command("npm test", { basePolicy: OFF }).policy).toBe(OFF);
  });

  it("the policy-file lock refuses, not asks, where nobody can say yes (Automatic)", () => {
    const r = evaluateToolPolicyWithRules({
      tool: fileTool as any,
      toolName: "create_new_file",
      basePolicy: ASK,
      parsedArgs: { filepath: "/home/me/.continue/config.yaml", contents: "x" },
      processedArgs: {
        resolvedPath: {
          uri: "file:///home/me/.continue/config.yaml",
          isWithinWorkspace: false,
        },
      },
      permissions: undefined,
      approval: {
        levels: {
          ...IDGAF,
          edits: "automatic",
          context: "automatic",
          tools: "automatic",
        },
        builtin: { ...NO_CHECKS, "protect-policy-files": true },
      },
    });
    expect(r.policy).toBe(OFF);
  });

  it("at Cautious every one of them still stops the call", () => {
    const cautious = POLICY_PRESETS.careful.levels;
    expect(
      command("terraform destroy", {
        approval: {
          levels: cautious,
          floor: ["runTerminalCommand(terraform destroy*)"],
        },
      }).policy,
    ).toBe(OFF);
    expect(write("/home/me/.continue/config.yaml", cautious).policy).not.toBe(
      ALLOW,
    );
    expect(command("cat .env", { approval: { levels: cautious } }).policy).toBe(
      ASK,
    );
  });
});
