import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import type { ApprovalSettings } from "./approval";
import { evaluateToolPolicyWithRules as evaluateAndRun } from "./evaluate";
import { wouldDecide } from "./idgafView.testutil";
import { DEFAULT_POLICY_LEVELS, type PolicyLevel } from "./policy";

// At IDGAF every call runs; these tests read what the guard would have
// decided (wouldDecide), which IDGAF records instead of acting on.
const evaluateToolPolicyWithRules = (
  input: Parameters<typeof evaluateAndRun>[0],
) => wouldDecide(evaluateAndRun(input));

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
const mcpTool = (originalFunctionName: string, readonly = false) => ({
  group: "fs",
  uri: "mcp://fs",
  originalFunctionName,
  readonly,
  evaluateToolCallPolicy: (base: any) => base,
});

const at = (level: PolicyLevel, builtin?: ApprovalSettings["builtin"]) =>
  ({
    levels: {
      ...DEFAULT_POLICY_LEVELS,
      tools: level,
      edits: level,
      context: level,
    },
    builtin,
  }) as ApprovalSettings;

const cwd = "C:/work/app";
const run = (command: string, approval?: ApprovalSettings, permissions?: any) =>
  evaluateToolPolicyWithRules({
    tool: terminalTool as any,
    toolName: "run_terminal_command",
    basePolicy: ALLOW,
    parsedArgs: { command },
    permissions,
    approval,
    cwd,
    shell: "bash",
  });
const edit = (
  filepath: string,
  approval?: ApprovalSettings,
  toolName = "edit_existing_file",
) =>
  evaluateToolPolicyWithRules({
    tool: fileTool as any,
    toolName,
    basePolicy: ALLOW,
    parsedArgs: { filepath },
    permissions: undefined,
    approval,
    cwd,
  });
const mcp = (
  fn: string,
  args: Record<string, unknown>,
  approval?: ApprovalSettings,
  readonly = false,
) =>
  evaluateToolPolicyWithRules({
    tool: mcpTool(fn, readonly) as any,
    toolName: `fs_${fn}`,
    basePolicy: ALLOW,
    parsedArgs: args,
    permissions: undefined,
    approval,
    cwd,
  });

const LEVELS: PolicyLevel[] = ["manual", "cautious", "permissive"];
const FILES = [
  "~/.continue/config.yaml",
  "~/.continue/permissions.yaml",
  "~/.continuous/permissions.yaml",
  "~/.continue/mcp-tool-pins.json",
  "~/.continue/audit/2026-11/s.jsonl",
  ".continue/rules/security.yaml",
  ".continuous/rules/a.md",
  ".continuerc.json",
];

describe("the policy files are a locked floor", () => {
  describe.each(FILES)("%s", (file) => {
    it("the edit tool asks below Automatic and is refused at Automatic and IDGAF", () => {
      for (const level of LEVELS) {
        expect(edit(file, at(level)).policy).toBe(ASK);
      }
      expect(edit(file, at("automatic")).policy).toBe(OFF);
      expect(edit(file, at("idgaf")).policy).toBe(OFF);
    });
  });

  it("a switched-off protect-config does not unlock it", () => {
    const off = { "protect-config": false } as const;
    expect(
      edit("~/.continue/permissions.yaml", at("cautious", off)).policy,
    ).toBe(ASK);
    expect(
      edit("~/.continue/permissions.yaml", at("idgaf", off)),
    ).toMatchObject({ policy: OFF, source: "floor" });
  });

  it("an allow rule cannot loosen it", () => {
    const r = evaluateToolPolicyWithRules({
      tool: fileTool as any,
      toolName: "edit_existing_file",
      basePolicy: ALLOW,
      parsedArgs: { filepath: "~/.continue/permissions.yaml" },
      permissions: { allow: ["writeFile(**)"] },
      approval: at("permissive"),
      cwd,
    });
    expect(r.policy).toBe(ASK);
  });

  it("works with no approval settings at all (asks)", () => {
    expect(edit("~/.continue/config.yaml").policy).toBe(ASK);
  });

  it("covers every write tool", () => {
    for (const t of [
      "create_new_file",
      "multi_edit",
      "single_find_and_replace",
    ]) {
      expect(edit("~/.continue/config.yaml", at("idgaf"), t).policy).toBe(OFF);
    }
  });

  describe("terminal commands that write or delete them", () => {
    it.each([
      "echo 'toolPermissions: {allow: [\"*\"]}' > ~/.continue/config.yaml",
      "echo x >> ~/.continue/permissions.yaml",
      "cat evil.yaml | tee ~/.continue/permissions.yaml",
      "mv evil.yaml ~/.continue/permissions.yaml",
      "cp evil.yaml .continue/rules/x.yaml",
      "sed -i 's/ask/allow/' ~/.continue/config.yaml",
      "rm ~/.continue/permissions.yaml",
      "rm -rf ~/.continue",
      "echo {} > .continuerc.json",
      "python -c \"open('/x','w')\" > $HOME/.continue/mcp-tool-pins.json",
    ])("%s", (command) => {
      expect(run(command, at("cautious")).policy).toBe(ASK);
      expect(run(command, at("idgaf"))).toMatchObject({
        policy: OFF,
        source: "floor",
      });
      expect(run(command, at("automatic")).policy).toBe(OFF);
    });

    it("reading them is not affected", () => {
      for (const c of [
        "cat ~/.continue/config.yaml",
        "grep allow ~/.continue/permissions.yaml",
        "git add .continue/rules/a.md",
      ]) {
        // The lock is not what decides (another guard may ask about a config file)
        const r = run(c, at("idgaf"));
        expect(r.policy).not.toBe(OFF);
        expect(r.source).not.toBe("floor");
      }
    });
  });

  describe("MCP filesystem tools", () => {
    it("write_file with a visible path is locked", () => {
      const args = { path: "~/.continue/permissions.yaml", content: "x" };
      expect(mcp("write_file", args, at("cautious")).policy).toBe(ASK);
      expect(mcp("write_file", args, at("idgaf")).policy).toBe(OFF);
    });

    it("move_file onto the policy file is locked (destination)", () => {
      const args = {
        source: "/tmp/e.yaml",
        destination: "~/.continue/config.yaml",
      };
      expect(mcp("move_file", args, at("idgaf")).policy).toBe(OFF);
    });

    it("a read-only MCP tool naming it is not", () => {
      const args = { path: "~/.continue/config.yaml" };
      const r = mcp("read_file", args, at("idgaf"), true);
      expect(r.policy).not.toBe(OFF);
      expect(r.source).not.toBe("floor");
    });
  });

  describe("ordinary paths are unchanged", () => {
    it("files, commands and MCP calls elsewhere", () => {
      expect(edit("src/a.ts", at("idgaf")).policy).toBe(ALLOW);
      expect(edit("notes/continue-config.yaml", at("cautious")).policy).toBe(
        ALLOW,
      );
      expect(run("echo hi > out.txt", at("idgaf")).policy).toBe(ALLOW);
      expect(
        mcp("write_file", { path: "src/b.ts", content: "" }, at("idgaf"))
          .policy,
      ).toBe(ALLOW);
    });
  });
});
