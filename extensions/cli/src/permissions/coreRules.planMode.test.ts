import fs from "fs";
import os from "os";
import path from "path";

import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { evaluateWithCoreRules, keepCoreVerdict } from "./coreRules.js";
import { explainAsk } from "./explainAsk.js";

/**
 * Plan mode in the CLI is decided by core's engine, the same function the IDE
 * calls: a call that a level or an allow rule would run waits unless it only
 * reads. `cliPermission` is what PLAN_MODE_POLICIES give the call.
 */
const REASON = "Plan mode asks before anything that changes files or state.";

const bashCheck = (base: any, args: Record<string, unknown>) =>
  evaluateTerminalCommandSecurity(base, args.command as string);

// git is vouched as read-only only in a repository whose config runs nothing
let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "cn-plan-rules-"));
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

const PLAN = { planMode: true as const, readOnlyTool: false };
const READS = { planMode: true as const, readOnlyTool: true };

type Over = Partial<Parameters<typeof evaluateWithCoreRules>[0]>;

const levels = (tools: "cautious" | "permissive" | "idgaf") => ({
  approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools } },
});

const bash = (command: string, over: Over = {}) =>
  evaluateWithCoreRules({
    cliToolName: "Bash",
    args: { command },
    // Plan mode's own list asks about Bash
    cliPermission: "ask",
    evaluateToolCallPolicy: bashCheck,
    assistantPermissions: undefined,
    isHeadless: false,
    cwd: repo,
    planTurn: PLAN,
    ...levels("permissive"),
    ...over,
  });

const mcp = (over: Over = {}) =>
  evaluateWithCoreRules({
    cliToolName: "mcp__github__create_issue",
    args: { title: "t" },
    cliPermission: "ask",
    assistantPermissions: undefined,
    isHeadless: false,
    cwd: repo,
    planTurn: PLAN,
    ...levels("permissive"),
    ...over,
  });

describe("Plan mode in the CLI, decided by the engine", () => {
  it("Tool use at Permissive: a command that changes things asks", async () => {
    // Outside Plan mode the level runs it
    expect(await bash("mkdir x", { planTurn: undefined })).toMatchObject({
      decision: "allow",
      source: "permissive",
    });
    expect(await bash("mkdir x")).toMatchObject({
      decision: "ask",
      by: "rules",
      source: "plan-mode",
      reason: REASON,
    });
  });

  it("a command that only reads runs", async () => {
    expect((await bash("git log"))?.decision).toBe("allow");
  });

  it("the person's allow rule does not exempt a command that changes things", async () => {
    const rule = {
      assistantPermissions: { allow: ["runTerminalCommand(mkdir *)"] },
      ...levels("cautious"),
    };
    expect(
      await bash("mkdir x", { ...rule, planTurn: undefined }),
    ).toMatchObject({
      decision: "allow",
      source: "allow-rule",
    });
    expect(await bash("mkdir x", rule)).toMatchObject({
      decision: "ask",
      source: "plan-mode",
    });
  });

  it("an MCP tool with no read-only hint asks, at Permissive and under an allow rule", async () => {
    expect((await mcp({ planTurn: undefined }))?.decision).toBe("allow");
    expect(await mcp()).toMatchObject({ decision: "ask", source: "plan-mode" });
    expect(
      await mcp({
        assistantPermissions: { allow: ["mcp__github__create_issue"] },
        ...levels("cautious"),
      }),
    ).toMatchObject({ decision: "ask", source: "plan-mode" });
  });

  it("a tool the CLI marks read-only runs", async () => {
    // An MCP tool whose server is trusted to say it only reads
    expect(
      (await mcp({ cliPermission: "allow", planTurn: READS }))?.decision,
    ).toBe("allow");
    expect(
      await evaluateWithCoreRules({
        cliToolName: "Read",
        args: { filepath: path.join(repo, ".git", "config") },
        cliPermission: "allow",
        assistantPermissions: undefined,
        isHeadless: false,
        cwd: repo,
        planTurn: READS,
        ...levels("permissive"),
      }),
    ).toMatchObject({ decision: "allow" });
  });

  it("an ask stays the ask it was", async () => {
    const outside = await bash("mkdir x", {
      ...levels("cautious"),
      planTurn: undefined,
    });
    expect(outside?.decision).toBe("ask");
    expect(await bash("mkdir x", levels("cautious"))).toEqual(outside);
  });

  it("IDGAF runs it: that level runs every call", async () => {
    expect(await bash("mkdir x", levels("idgaf"))).toMatchObject({
      decision: "allow",
      source: "idgaf",
    });
  });

  it("with the reviewer on, the call stays with the person", async () => {
    const chat = vi.fn(async () => ({
      role: "assistant",
      content: '{"decision":"allow","reason":"fine"}',
    }));
    const verdict = await mcp({
      autoReview: true,
      reviewer: { chat } as any,
      approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools: "automatic" } },
    });
    expect(verdict).toMatchObject({
      decision: "ask",
      by: "rules",
      source: "plan-mode",
      reason: REASON,
    });
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("keepCoreVerdict and the prompt", () => {
  it("keeps Plan mode's hold at the default levels, over an allow of the CLI's", () => {
    const held = {
      decision: "ask" as const,
      by: "rules" as const,
      source: "plan-mode" as const,
      reason: REASON,
    };
    expect(
      keepCoreVerdict(held, {
        defaultsOnly: true,
        hasPermissions: false,
        autoReview: false,
      }),
    ).toBe(held);
  });

  it("the prompt says the call waits because of Plan mode", async () => {
    const verdict = await bash("mkdir x");
    const why = explainAsk({
      toolName: "Bash",
      args: { command: "mkdir x" },
      verdict,
    });
    expect(why.reason).toBe(REASON);
    expect(why.source).toEqual({
      what: "Plan mode, the mode this session is in (plan-mode)",
    });
    // No allow rule stops this ask
    expect(why.ruleStopsAsk).toBe(false);
  });
});
