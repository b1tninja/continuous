import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  headless: false,
  decisions: [] as Record<string, unknown>[],
}));

vi.mock("../services/index.js", () => ({
  services: { toolPermissions: { isHeadless: () => store.headless } },
}));
vi.mock("../services/QuizService.js", () => ({
  quizService: { askQuestion: vi.fn(async () => "never asked") },
}));
vi.mock("../audit/cliAudit.js", () => ({
  cliAuditTrail: () => ({
    decision: (d: Record<string, unknown>) => store.decisions.push(d),
  }),
  cliAuditSession: () => "test-session",
}));

import {
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import { quizService } from "../services/QuizService.js";
import {
  openPendingQuestions,
  resetPendingQuestions,
} from "../util/pendingQuestions.js";

import { askQuestionTool } from "./askQuestion.js";

const args = {
  question: "ISO or readable?",
  options: ["ISO 8601", "Readable (recommended)"],
  defaultAnswer: "ISO 8601",
  type: "irreversible",
};

describe.each([
  ["the terminal UI", false],
  ["headless and serve", true],
])("AskQuestion at Questions IDGAF in %s", (_name, headless) => {
  beforeEach(() => {
    store.headless = headless;
    store.decisions = [];
    resetPendingQuestions();
    vi.mocked(quizService.askQuestion).mockClear();
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions: "idgaf" });
  });
  afterEach(() => resetPolicyLevels());

  it("answers from the labelled option and neither asks nor holds", async () => {
    const result = await askQuestionTool.run(args);
    expect(quizService.askQuestion).not.toHaveBeenCalled();
    expect(openPendingQuestions()).toHaveLength(0);
    expect(result).toContain(
      "Auto-answered: ISO or readable? -> Readable (Questions: IDGAF)",
    );
    expect(result).toContain("Nobody was asked");
  });

  it("falls back to the model's pick, the first option, then best judgment", async () => {
    expect(
      await askQuestionTool.run({
        question: "q",
        options: ["a", "b"],
        defaultAnswer: "b",
      }),
    ).toContain("-> b ");
    expect(
      await askQuestionTool.run({ question: "q", options: ["a", "b"] }),
    ).toContain("-> a ");
    expect(await askQuestionTool.run({ question: "q" })).toContain(
      "No one is available to answer; use your best judgment and state the assumption",
    );
  });

  it("records the answer in the audit trail as the system's", async () => {
    await askQuestionTool.run(args);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0]).toMatchObject({
      by: "system",
      source: "Questions: IDGAF",
      policy: "allow",
      session: "test-session",
      tool: "question",
    });
    expect(String(store.decisions[0].args)).toContain("Readable");
  });
});

describe("AskQuestion below IDGAF is unchanged", () => {
  beforeEach(() => {
    store.decisions = [];
    resetPendingQuestions();
    vi.mocked(quizService.askQuestion).mockClear();
  });
  afterEach(() => resetPolicyLevels());

  it.each(["manual", "cautious", "automatic", "permissive"] as const)(
    "%s: the terminal UI asks, headless holds",
    async (questions) => {
      setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions });
      store.headless = false;
      await askQuestionTool.run(args);
      expect(quizService.askQuestion).toHaveBeenCalledOnce();
      store.headless = true;
      await askQuestionTool.run(args);
      expect(openPendingQuestions()).toHaveLength(1);
      expect(store.decisions).toHaveLength(0);
    },
  );
});
