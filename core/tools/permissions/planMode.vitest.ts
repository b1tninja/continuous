import fs from "fs";
import os from "os";
import path from "path";

import {
  evaluateTerminalCommandSecurity,
  type ToolPolicy,
} from "@continuedev/terminal-security";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { autoReviewToolCall } from "./auto/handler";
import { AutoReviewSessions } from "./auto/state";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { onlyReads, PLAN_MODE_HOLD_REASON, planModeVerdict } from "./planMode";
import { DEFAULT_POLICY_LEVELS, type PolicyLevels } from "./policy";

const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

// git is vouched as read-only only in a repository whose config runs nothing,
// so the tests have one of their own and no machine-wide git config
let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(
    path.join(repo, ".git", "config"),
    "[core]\n\tbare = false\n",
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(repo, "no-global-config"));
  vi.stubEnv("GIT_CONFIG_SYSTEM", path.join(repo, "no-system-config"));
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("planModeVerdict: the verdict outside Plan mode, then Plan mode's", () => {
  const changes = { readOnly: false };

  it("a call that would run waits, with Plan mode as the source and the reason", () => {
    for (const source of [
      undefined,
      "allow-rule",
      "permissive",
      "trusted-host",
    ]) {
      expect(planModeVerdict({ policy: ALLOW, source }, changes)).toEqual({
        policy: ASK,
        source: "plan-mode",
        reason: "Plan mode asks before anything that changes files or state.",
      });
    }
  });

  it("a call that only reads runs", () => {
    const verdict = { policy: ALLOW, source: "permissive" };
    expect(planModeVerdict(verdict, { readOnly: true })).toBe(verdict);
  });

  it("an ask stays the ask it was, and a refusal stays a refusal", () => {
    const ask = { policy: ASK, source: "ask-rule", reason: "Your rule asks." };
    const deny = { policy: OFF, source: "deny-rule", reason: "Blocked." };
    expect(planModeVerdict(ask, changes)).toBe(ask);
    expect(planModeVerdict(deny, changes)).toBe(deny);
    expect(planModeVerdict(deny, { readOnly: true })).toBe(deny);
  });

  it("IDGAF runs it: that level runs every call in every mode", () => {
    const verdict = { policy: ALLOW, source: "idgaf" };
    expect(planModeVerdict(verdict, { readOnly: false, idgaf: true })).toBe(
      verdict,
    );
  });
});

describe("onlyReads", () => {
  const bash = { shell: "bash" as const };

  it("is the tool's read-only flag", () => {
    expect(onlyReads("read_file", { readonly: true }, {})).toBe(true);
    expect(onlyReads("create_new_file", { readonly: false }, {})).toBe(false);
    expect(onlyReads("github_create_issue", undefined, {})).toBe(false);
  });

  it("or a terminal command the parser vouches as only reading", () => {
    const terminal = { readonly: false };
    const call = (command: string) => ({
      parsedArgs: { command },
      cwd: repo,
      ...bash,
    });
    expect(onlyReads("run_terminal_command", terminal, call("git log"))).toBe(
      true,
    );
    expect(onlyReads("run_terminal_command", terminal, call("touch x"))).toBe(
      false,
    );
    // Without the shell that will read it, nothing is vouched
    expect(
      onlyReads("run_terminal_command", terminal, {
        parsedArgs: { command: "git log" },
        cwd: repo,
      }),
    ).toBe(false);
  });

  it("does not read another tool's `command` argument as a shell command", () => {
    expect(
      onlyReads("mcp__ops__run", undefined, {
        parsedArgs: { command: "git log" },
        ...bash,
      }),
    ).toBe(false);
  });
});

/**
 * The engine in a Plan turn. `tools` is the level of Tool use; Context use is
 * set with it, so a command that only reads is at the same level.
 */
type Level = PolicyLevels["tools"];

const terminalTool = {
  group: "Built-In",
  readonly: false,
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};
const readTool = { group: "Built-In", readonly: true };
const editTool = { group: "Built-In", readonly: false };
const mcpTool = {
  group: "github",
  uri: "mcp:github",
  originalFunctionName: "create_issue",
};

interface Call {
  tool: any;
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** An allow rule the person wrote for exactly this call */
  rule: string;
}

const CALLS: Record<string, Call> = {
  "read-only tool": {
    tool: readTool,
    toolName: "read_file",
    parsedArgs: { filepath: "a.ts" },
    rule: "readFile",
  },
  "git log": {
    tool: terminalTool,
    toolName: "run_terminal_command",
    parsedArgs: { command: "git log" },
    rule: "runTerminalCommand(git log*)",
  },
  "touch x": {
    tool: terminalTool,
    toolName: "run_terminal_command",
    parsedArgs: { command: "touch x" },
    rule: "runTerminalCommand(touch *)",
  },
  "file edit": {
    tool: editTool,
    toolName: "create_new_file",
    parsedArgs: { filepath: "a.ts", contents: "x" },
    rule: "writeFile",
  },
  "MCP tool, no read-only hint": {
    tool: mcpTool,
    toolName: "github_create_issue",
    parsedArgs: { title: "t" },
    rule: "mcp__github__create_issue",
  },
};

function evaluate(
  name: keyof typeof CALLS,
  level: Level,
  opts: { rule?: boolean; planMode?: boolean; base?: ToolPolicy } = {},
) {
  const call = CALLS[name];
  const levels = {
    ...DEFAULT_POLICY_LEVELS,
    context: level,
    tools: level,
    edits: level,
  };
  return evaluateToolPolicyWithRules({
    tool: call.tool,
    toolName: call.toolName,
    // A read-only tool's own setting runs it; everything else asks
    basePolicy: opts.base ?? (call.tool.readonly ? ALLOW : ASK),
    parsedArgs: call.parsedArgs,
    permissions: opts.rule ? { allow: [call.rule] } : undefined,
    approval: { levels },
    cwd: repo,
    shell: "bash",
    planMode: opts.planMode ?? true,
  });
}

describe("the engine in Plan mode: the truth table", () => {
  // [call, level, an allow rule, the verdict in Plan mode]
  const TABLE: [
    keyof typeof CALLS,
    Level,
    boolean,
    typeof ASK | typeof ALLOW,
  ][] = [
    ["read-only tool", "cautious", false, ALLOW],
    ["read-only tool", "permissive", false, ALLOW],
    ["read-only tool", "cautious", true, ALLOW],
    ["git log", "cautious", false, ASK],
    ["git log", "permissive", false, ALLOW],
    ["git log", "cautious", true, ALLOW],
    ["touch x", "cautious", false, ASK],
    ["touch x", "permissive", false, ASK],
    ["touch x", "cautious", true, ASK],
    ["touch x", "permissive", true, ASK],
    ["file edit", "cautious", false, ASK],
    ["file edit", "permissive", false, ASK],
    ["file edit", "cautious", true, ASK],
    ["MCP tool, no read-only hint", "cautious", false, ASK],
    ["MCP tool, no read-only hint", "permissive", false, ASK],
    ["MCP tool, no read-only hint", "cautious", true, ASK],
    ["MCP tool, no read-only hint", "permissive", true, ASK],
  ];

  it.each(TABLE)("%s at %s, allow rule %s", (name, level, rule, expected) => {
    expect(evaluate(name, level, { rule }).policy).toBe(expected);
  });

  it("holds exactly what a level or an allow rule would have run", () => {
    for (const name of ["touch x", "MCP tool, no read-only hint"] as const) {
      for (const opts of [
        { level: "permissive" as const, rule: false, was: "permissive" },
        { level: "cautious" as const, rule: true, was: "allow-rule" },
      ]) {
        const outside = evaluate(name, opts.level, {
          rule: opts.rule,
          planMode: false,
        });
        expect(outside).toMatchObject({ policy: ALLOW, source: opts.was });
        expect(evaluate(name, opts.level, { rule: opts.rule })).toMatchObject({
          policy: ASK,
          source: "plan-mode",
          reason: PLAN_MODE_HOLD_REASON,
        });
      }
    }
  });

  it("holds a tool whose own setting runs it", () => {
    const outside = evaluate("MCP tool, no read-only hint", "cautious", {
      base: ALLOW,
      planMode: false,
    });
    expect(outside.policy).toBe(ALLOW);
    expect(
      evaluate("MCP tool, no read-only hint", "cautious", { base: ALLOW }),
    ).toMatchObject({ policy: ASK, source: "plan-mode" });
  });

  it("leaves an ask with the reason it had", () => {
    const outside = evaluate("touch x", "manual", { planMode: false });
    expect(outside).toMatchObject({ policy: ASK, source: "manual" });
    expect(evaluate("touch x", "manual")).toEqual(outside);
  });

  it("keeps a refusal", () => {
    const refused = evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command: "touch x" },
      permissions: { deny: ["runTerminalCommand(touch *)"] },
      approval: {
        levels: { ...DEFAULT_POLICY_LEVELS, tools: "permissive" },
      },
      shell: "bash",
      planMode: true,
    });
    expect(refused).toMatchObject({ policy: OFF, source: "deny-rule" });
  });

  it("takes the surface's word that a tool only reads (the CLI's tools carry no flag)", () => {
    const input = {
      tool: { group: "Built-In" } as any,
      toolName: "fetch_url_content",
      basePolicy: ALLOW,
      parsedArgs: { url: "https://example.com" },
      permissions: undefined,
      approval: { levels: DEFAULT_POLICY_LEVELS },
      planMode: true,
    };
    const outside = evaluateToolPolicyWithRules({ ...input, planMode: false });
    expect(outside.policy).toBe(ALLOW);
    expect(evaluateToolPolicyWithRules(input).source).toBe("plan-mode");
    expect(
      evaluateToolPolicyWithRules({ ...input, readOnlyTool: true }),
    ).toEqual(outside);
  });

  it("IDGAF runs it, and the decision says Plan mode would have asked", () => {
    for (const name of ["touch x", "MCP tool, no read-only hint"] as const) {
      const ran = evaluate(name, "idgaf");
      expect(ran).toMatchObject({ policy: ALLOW, source: "idgaf" });
      expect(ran.idgafOverride).toBeDefined();
    }
    // Nothing else objected, so Plan mode is the objection on record
    const ran = evaluate("MCP tool, no read-only hint", "idgaf", {
      base: ALLOW,
    });
    expect(ran.policy).toBe(ALLOW);
    expect(ran.idgafOverride).toEqual({
      policy: ASK,
      source: "plan-mode",
      reason: PLAN_MODE_HOLD_REASON,
    });
    expect(ran.reason).toContain(
      `Below IDGAF this call would have been asked: ${PLAN_MODE_HOLD_REASON}`,
    );
  });

  it("changes nothing when the turn is not a Plan turn", () => {
    expect(evaluate("touch x", "permissive", { planMode: false }).source).toBe(
      "permissive",
    );
  });
});

describe("the reviewer in Plan mode", () => {
  const reviewer = {
    model: "reviewer",
    providerName: "test",
    chat: async () => {
      asked += 1;
      return {
        role: "assistant",
        content: '{"decision":"allow","reason":"looks fine"}',
      };
    },
  };
  let asked = 0;

  const review = (name: keyof typeof CALLS, planMode: boolean) => {
    const call = CALLS[name];
    return autoReviewToolCall(
      {
        tool: call.tool,
        permissions: undefined,
        enabled: true,
        reviewer: reviewer as any,
        shell: "bash",
        environment: { workspaceDirs: [], os: "linux" },
        sessions: new AutoReviewSessions(),
      },
      {
        sessionId: "plan-mode-test",
        toolName: call.toolName,
        basePolicy: ASK,
        parsedArgs: call.parsedArgs,
        history: { userMessages: ["file the issue"], toolCalls: [] },
        approval: {
          levels: {
            ...DEFAULT_POLICY_LEVELS,
            context: "automatic",
            tools: "automatic",
          },
        },
        planMode,
      },
    );
  };

  it("is not asked about a call that changes things: the call stays with the person", async () => {
    asked = 0;
    const reply = await review("MCP tool, no read-only hint", true);
    expect(reply).toMatchObject({
      decision: "ask",
      by: "rules",
      ruleSource: "plan-mode",
      reason: PLAN_MODE_HOLD_REASON,
    });
    expect(asked).toBe(0);
  });

  it("is asked outside Plan mode", async () => {
    asked = 0;
    const reply = await review("MCP tool, no read-only hint", false);
    expect(reply.by).not.toBe("rules");
    expect(asked).toBe(1);
  });
});
