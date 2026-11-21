import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { POLICY_PRESETS, type PolicyLevels } from "./policy";
import { builtinForPreset } from "./safetyDegrees";

/**
 * IDGAF (2.16.2): the permission layer never refuses or holds a call. Every
 * site that refused or asked even at IDGAF before is listed here; each call
 * runs, and the decision records what would have stopped it.
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

describe("IDGAF runs every call and records what would have objected", () => {
  it.each([
    [
      "a floor rule (binds at every other level)",
      () =>
        command("terraform destroy", {
          approval: {
            levels: IDGAF,
            builtin: NO_CHECKS,
            floor: ["runTerminalCommand(terraform destroy*)"],
          },
        }),
      OFF,
      "floor",
    ],
    [
      "the policy-file lock",
      () => write("/home/me/.continue/config.yaml"),
      OFF,
      "floor",
    ],
    ["the run-time write lock", () => command("rm -rf $DIR"), ASK, "floor"],
    [
      "a deny rule (Never) in config.yaml",
      () =>
        command("git push origin main", {
          permissions: { deny: ["runTerminalCommand(git push*)"] },
        }),
      OFF,
      "deny-rule",
    ],
  ] as const)("%s", (_name, decide, would, source) => {
    const r = decide();
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("idgaf");
    expect(r.idgafOverride?.policy).toBe(would);
    if (source) expect(r.idgafOverride?.source).toBe(source);
    // The model is never told: the reason is for the chip and the audit trail
    expect(r.reason).toContain("IDGAF");
  });

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
      expect(r.source).toBe("idgaf");
      // The check did not run, so there is nothing to record
      expect(r.idgafOverride).toBeUndefined();
    },
  );

  it.each(CHECKS)(
    "%s: IDGAF levels with the checks left on still stop it",
    (_name, text, stops) => {
      const r = command(text, { approval: { levels: IDGAF } });
      expect(r.policy).toBe(stops);
      expect(r.source).not.toBe("idgaf");
    },
  );

  it("records nothing when nothing would have objected", () => {
    const r = command("npm test");
    expect(r.policy).toBe(ALLOW);
    expect(r.idgafOverride).toBeUndefined();
  });

  it("a tool the person switched off stays off (it is not offered at all)", () => {
    expect(command("npm test", { basePolicy: OFF }).policy).toBe(OFF);
  });

  it("below IDGAF every one of them still stops the call", () => {
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
