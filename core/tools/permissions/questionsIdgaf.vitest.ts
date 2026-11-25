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
  it("only Delegate never asks", () => {
    expect(questionsNeverAsk("delegate")).toBe(true);
    for (const level of [
      "manual",
      "cautious",
      "permissive",
      "automatic",
    ] as const) {
      expect(questionsNeverAsk(level), level).toBe(false);
    }
    expect(questionsNeverAsk(undefined)).toBe(false);
    expect(questionsAutoAnswer("delegate")).toBe(true);
  });

  it("Delegate: the agent decides every type, your own list does not apply", () => {
    const own = settings("delegate", [...QUESTION_TYPES]);
    for (const type of [...QUESTION_TYPES, undefined, "made up"]) {
      expect(questionDecider(own, type), String(type)).toBe("agent");
    }
  });

  it("Permissive, and Automatic (review, not built: works as Permissive), send your own list to you", () => {
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

describe("the Questions level does not change what a tool call is allowed", () => {
  const ASK = "allowedWithPermission" as const;
  const ALLOW = "allowedWithoutPermission" as const;
  const terminalTool = {
    group: "Built-In",
    evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, args.command as string),
  };
  const run = (
    tools: PolicyLevel,
    questions: PolicyLevel,
    builtin?: Record<string, boolean>,
  ) =>
    evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command: "git push origin main" },
      permissions: undefined,
      shell: "bash",
      approval: {
        levels: { ...DEFAULT_POLICY_LEVELS, tools, questions },
        ...(builtin ? { builtin } : {}),
      },
    });

  it.each([
    "manual",
    "cautious",
    "permissive",
    "automatic",
    "delegate",
  ] as const)(
    "with the IDGAF preset's switches and Questions at %s, Permissive tools run the call",
    (questions) => {
      const r = run("permissive", questions, builtinForPreset("idgaf"));
      expect(r.policy).toBe(ALLOW);
    },
  );

  it("Delegate on Questions does not let a tool area skip its own asking", () => {
    // Tool use below Permissive keeps asking: that is a tool decision, not a question
    expect(run("cautious", "delegate").policy).toBe(ASK);
  });

  it("the answer is the same at every Questions level", () => {
    const verdicts = new Set(
      (
        ["manual", "cautious", "permissive", "automatic", "delegate"] as const
      ).map((q) => run("cautious", q).policy),
    );
    expect(verdicts.size).toBe(1);
  });
});
