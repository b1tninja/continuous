import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { POLICY_PRESETS, type PolicyLevels } from "./policy";

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
    approval: { levels: IDGAF },
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
    approval: { levels },
  });

describe("IDGAF runs every call and records what would have objected", () => {
  it.each([
    [
      "a floor rule (binds at every other level)",
      () =>
        command("terraform destroy", {
          approval: {
            levels: IDGAF,
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
      "a command that hides what it runs",
      () => command("G=rm; $G -rf ~"),
      OFF,
      undefined,
    ],
    [
      "obfuscation the safety floor cannot see through",
      () => command("rm${IFS}-rf${IFS}~"),
      OFF,
      undefined,
    ],
    [
      "a deny rule (Never) in config.yaml",
      () =>
        command("git push origin main", {
          permissions: { deny: ["runTerminalCommand(git push*)"] },
        }),
      OFF,
      "deny-rule",
    ],
    [
      "a protected secret file",
      () => command("cat .env"),
      ASK,
      "protected-path",
    ],
    ["the safety floor", () => command("rm -rf /"), OFF, undefined],
  ] as const)("%s", (_name, decide, would, source) => {
    const r = decide();
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("idgaf");
    expect(r.idgafOverride?.policy).toBe(would);
    if (source) expect(r.idgafOverride?.source).toBe(source);
    // The model is never told: the reason is for the chip and the audit trail
    expect(r.reason).toContain("IDGAF");
  });

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
