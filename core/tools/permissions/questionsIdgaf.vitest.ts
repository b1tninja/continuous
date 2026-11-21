import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";

import { evaluateToolPolicyWithRules } from "./evaluate";
import {
  DEFAULT_POLICY_LEVELS,
  QUESTION_TYPES,
  questionDecider,
  questionsAutoAnswer,
  questionsNeverAsk,
  type PolicyLevel,
  type PolicySettings,
} from "./policy";
import { builtinForPreset } from "./safetyDegrees";

const settings = (
  questions: PolicyLevel,
  youDecide?: (typeof QUESTION_TYPES)[number][],
): PolicySettings => ({
  levels: { ...DEFAULT_POLICY_LEVELS, questions },
  ...(youDecide ? { questions: { youDecide } } : {}),
});

describe("Questions: who decides", () => {
  it("only IDGAF never asks", () => {
    expect(questionsNeverAsk("idgaf")).toBe(true);
    for (const level of [
      "manual",
      "cautious",
      "automatic",
      "permissive",
    ] as const) {
      expect(questionsNeverAsk(level)).toBe(false);
    }
    expect(questionsNeverAsk(undefined)).toBe(false);
    expect(questionsAutoAnswer("idgaf")).toBe(true);
  });

  it("IDGAF: the agent decides every type, your own list does not apply", () => {
    const own = settings("idgaf", [...QUESTION_TYPES]);
    for (const type of [...QUESTION_TYPES, undefined, "made up"]) {
      expect(questionDecider(own, type), String(type)).toBe("agent");
    }
  });

  it("Permissive and Automatic still send your own list to you", () => {
    for (const level of ["permissive", "automatic"] as const) {
      const own = settings(level, ["irreversible"]);
      expect(questionDecider(own, "irreversible")).toBe("person");
      expect(questionDecider(own, "detail")).toBe("agent");
    }
  });

  it("Manual and Cautious are unchanged", () => {
    expect(questionDecider(settings("manual"), "detail")).toBe("person");
    expect(questionDecider(settings("cautious"), "detail")).toBe("agent");
    expect(questionDecider(settings("cautious"), "irreversible")).toBe(
      "person",
    );
  });
});

describe("a call a guard would hold at a IDGAF area runs, whatever Questions is", () => {
  const ASK = "allowedWithPermission" as const;
  const ALLOW = "allowedWithoutPermission" as const;
  const terminalTool = {
    group: "Built-In",
    evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, args.command as string),
  };
  const run = (tools: PolicyLevel, questions: PolicyLevel) =>
    evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command: "rm -rf $DIR" },
      permissions: undefined,
      shell: "bash",
      approval: {
        levels: { ...DEFAULT_POLICY_LEVELS, tools, questions },
        // The IDGAF preset leaves no safety check on
        ...(tools === "idgaf" ? { builtin: builtinForPreset("idgaf") } : {}),
      },
    });

  it.each(["cautious", "idgaf"] as const)(
    "IDGAF tools with Questions %s runs it and never asks or refuses",
    (questions) => {
      const r = run("idgaf", questions);
      expect(r.policy).toBe(ALLOW);
      expect(r.source).toBe("idgaf");
    },
  );

  it("IDGAF levels with the check left on still ask, whatever Questions is", () => {
    const r = evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command: "rm -rf $DIR" },
      permissions: undefined,
      shell: "bash",
      approval: {
        levels: {
          ...DEFAULT_POLICY_LEVELS,
          tools: "idgaf",
          questions: "idgaf",
        },
      },
    });
    expect(r.policy).toBe(ASK);
  });

  it("a tool area below IDGAF keeps its own asking: that is not a question", () => {
    expect(run("cautious", "idgaf").policy).toBe(ASK);
  });
});
