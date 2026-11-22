import path from "path";

import { suggestAllowRule } from "core/tools/permissions/suggest.js";
import { describe, expect, it } from "vitest";

import { env } from "../env.js";

import { askSourceText, truncateMiddle } from "./askWhy.js";
import type { CoreVerdict } from "./coreRules.js";
import { PLAN_MODE_POLICIES } from "./defaultPolicies.js";
import { explainAsk, suggestRuleForCall } from "./explainAsk.js";
import { checkToolPermission } from "./permissionChecker.js";
import { resolvePermissionPrecedence } from "./precedenceResolver.js";

const bash = (command: string) => ({ name: "Bash", arguments: { command } });

/** The CLI's own answer for a call, as the approval path works it out. */
function cliAsk(
  policies: Parameters<typeof checkToolPermission>[1]["policies"],
  call: { name: string; arguments: Record<string, unknown> },
) {
  const check = checkToolPermission(call, { policies });
  expect(check.permission).toBe("ask");
  return explainAsk({
    toolName: call.name,
    args: call.arguments,
    matchedPolicy: check.matchedPolicy,
  });
}

const engineAsk = (verdict: Partial<CoreVerdict>) =>
  explainAsk({
    toolName: "Bash",
    args: { command: "ls" },
    verdict: { decision: "ask", by: "rules", ...verdict },
  });

describe("explainAsk: the CLI's own lists", () => {
  it("names the flag when --ask asked", () => {
    const policies = resolvePermissionPrecedence({
      commandLineFlags: { ask: ["Bash(git push*)"] },
      personalSettings: false,
    });
    const why = cliAsk(policies, bash("git push"));
    expect(why.reason).toBe(
      "This session was started with --ask Bash(git push*), so this asks.",
    );
    expect(askSourceText(why.source)).toBe(
      "the command-line flag --ask Bash(git push*)",
    );
  });

  it("says a tool asks by default when nothing of the person's matched", () => {
    const policies = resolvePermissionPrecedence({ personalSettings: false });
    const why = cliAsk(policies, bash("npm test"));
    expect(why.reason).toBe(
      "Bash asks by default, and no allow rule covers this call.",
    );
    expect(why.source.what).toBe(
      "the default permissions (no rule of yours matched)",
    );
    const unlisted = cliAsk(policies, { name: "some_tool", arguments: {} });
    expect(unlisted.reason).toBe(
      "some_tool is not in any permission list, and unlisted tools ask.",
    );
  });

  it("names Plan mode when the mode's own list asked", () => {
    const why = cliAsk(PLAN_MODE_POLICIES, bash("npm test"));
    expect(why.reason).toContain("Plan mode asks");
    expect(why.source.what).toBe(
      "Plan mode, the mode this session is in (plan-mode)",
    );
    // An allow rule does not stop Plan mode's ask
    expect(why.ruleStopsAsk).toBe(false);
  });

  it("names the hook over the list that allowed the call", () => {
    const why = explainAsk({
      toolName: "Read",
      args: { filepath: "a.ts" },
      matchedPolicy: { tool: "Read", permission: "allow" },
      hookAsked: true,
    });
    expect(why.reason).toBe(
      "A PreToolUse hook asked for this call to be confirmed.",
    );
    expect(why.ruleStopsAsk).toBe(false);
  });

  it("does not blame a policy that allowed the call", () => {
    const policies = resolvePermissionPrecedence({ personalSettings: false });
    const read = policies.find((p) => p.tool === "Read");
    const why = explainAsk({
      toolName: "Read",
      args: { filepath: "a.ts" },
      matchedPolicy: read,
    });
    expect(why.reason).toBe("No allow rule covers this call, so it asks.");
  });
});

describe("explainAsk: the engine's verdict", () => {
  it("an ask rule in the person's own config.yaml names that file", () => {
    const why = engineAsk({
      source: "ask-rule",
      rule: "runTerminalCommand(git push*)",
      ruleOrigin: "user-config",
      reason:
        "Your rule runTerminalCommand(git push*) asks before running this.",
    });
    expect(askSourceText(why.source)).toBe(
      `your toolPermissions.ask rule runTerminalCommand(git push*) in ${path.join(env.continueHome, "config.yaml")}`,
    );
    expect(why.ruleStopsAsk).toBe(true);
  });

  it("each protection names the built-in check that owns it, with its id", () => {
    expect(
      engineAsk({ source: "protected-path", protection: "destructive-command" })
        .source.what,
    ).toBe(
      'the built-in check "Ask before destroying work" (ask-destructive-commands)',
    );
    expect(engineAsk({ source: "protected-path" }).source.what).toBe(
      "the built-in check for protected paths (protected-path)",
    );
  });

  it("a check that asks is said not to be stopped by a rule", () => {
    for (const source of [
      "tainted-session",
      "secret-egress",
      "shell-hint",
      "manual",
    ] as const) {
      const why = engineAsk({ source, reason: "Because." });
      expect(why.reason).toBe("Because.");
      expect(why.source.what).toContain(`(${source})`);
      expect(why.ruleStopsAsk).toBe(false);
    }
  });

  it("a failed check says the check itself asked", () => {
    const why = engineAsk({ by: "system", reason: "It could not be checked." });
    expect(why.source.what).toBe("the permission check itself, not a rule");
  });

  it("a verdict with nothing to say leaves the reason to the CLI's lists", () => {
    const why = explainAsk({
      toolName: "Bash",
      args: { command: "ls" },
      verdict: { decision: "ask", by: "rules" },
      matchedPolicy: resolvePermissionPrecedence({
        personalSettings: false,
      }).find((p) => p.tool === "Bash"),
    });
    expect(why.reason).toContain("Bash asks by default");
  });
});

describe("suggestRuleForCall is core's suggestAllowRule for the same call", () => {
  it("a file read, by the path core's rules use", () => {
    expect(suggestRuleForCall("Read", { filepath: "src/a.ts" })).toMatchObject(
      suggestAllowRule({
        toolName: "read_file",
        parsedArgs: { filepath: "src/a.ts" },
      }),
    );
  });

  it("an MCP tool, by its server and tool", () => {
    const expected = suggestAllowRule({
      toolName: "mcp__github__create_issue",
      parsedArgs: {},
      mcp: { serverName: "github", toolName: "create_issue" },
    });
    expect(suggestRuleForCall("mcp__github__create_issue", {})).toMatchObject(
      expected,
    );
    expect(
      suggestRuleForCall(
        "create_issue",
        {},
        { mcpServer: "github", mcpToolName: "create_issue" },
      ),
    ).toMatchObject(expected);
  });

  it("a chained command gets core's refusal, not a rule", () => {
    const got = suggestRuleForCall("Bash", { command: "npm test && git push" });
    expect(got).toEqual(
      suggestAllowRule({
        toolName: "run_terminal_command",
        parsedArgs: { command: "npm test && git push" },
      }),
    );
    expect(got.ok).toBe(false);
  });
});

describe("the source on one line", () => {
  it("keeps both ends of a long text", () => {
    expect(truncateMiddle("abcdefghij", 7)).toBe("abc…hij");
    expect(truncateMiddle("abcdefghij", 10)).toBe("abcdefghij");
    // a path keeps more of its end: the file name tells it apart
    expect(truncateMiddle("C:/Users/someone/permissions.yaml", 21, 0.75)).toBe(
      "C:/Us…ermissions.yaml",
    );
  });

  it("fits the width, cutting only the rule and the path", () => {
    const source = {
      what: "your ask rule",
      rule: `Bash(${"x".repeat(80)})`,
      file: `C:/Users/${"y".repeat(60)}/permissions.yaml`,
    };
    const line = askSourceText(source, 68);
    expect(line.length).toBeLessThanOrEqual(68);
    expect(line).toMatch(
      /^your ask rule Bash\(x+…x+\) in C:\/.*…y*\/permissions\.yaml$/,
    );
    // whole when it is asked for whole
    expect(askSourceText(source)).toBe(
      `your ask rule ${source.rule} in ${source.file}`,
    );
  });

  it("leaves a short one whole and cuts only the long one", () => {
    const line = askSourceText(
      {
        what: "your ask rule",
        rule: "Bash",
        file: `C:/${"y".repeat(90)}/p.yaml`,
      },
      60,
    );
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).toContain("your ask rule Bash in C:/");
    expect(line).toMatch(/…y+\/p\.yaml$/);
  });
});
