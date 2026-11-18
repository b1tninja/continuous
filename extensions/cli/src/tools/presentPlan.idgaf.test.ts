import fs from "fs";
import os from "os";
import path from "path";

import type { TaskPlan } from "core/index.js";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  plan: undefined as TaskPlan | undefined,
  planFile: undefined as string | undefined,
  headless: false,
  mode: "plan",
  decisions: [] as Record<string, unknown>[],
}));

vi.mock("../session.js", () => ({
  getSessionTaskPlan: () => store.plan,
  updateSessionTaskPlan: (plan: TaskPlan | undefined) => {
    store.plan = plan;
  },
  getSessionPlanFile: () => store.planFile,
  updateSessionPlanFile: (file: string | undefined) => {
    store.planFile = file;
  },
  getSessionLoop: () => undefined,
}));
vi.mock("../services/index.js", () => ({
  services: {
    toolPermissions: {
      isHeadless: () => store.headless,
      switchMode: (mode: string) => {
        store.mode = mode;
      },
    },
  },
}));
vi.mock("../services/QuizService.js", () => ({
  quizService: { askQuestion: vi.fn(async () => "Build") },
}));
vi.mock("../init.js", () => ({ safeStderr: () => undefined }));
vi.mock("../loop/loopSession.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../loop/loopSession.js")>()),
  requestLoopTurnEnd: vi.fn(),
}));
vi.mock("../audit/cliAudit.js", () => ({
  cliAuditTrail: () => ({
    decision: (d: Record<string, unknown>) => store.decisions.push(d),
  }),
  cliAuditSession: () => "test-session",
}));

import { requestLoopTurnEnd } from "../loop/loopSession.js";
import {
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import { quizService } from "../services/QuizService.js";

import { presentPlanTool } from "./presentPlan.js";

const args = {
  title: "Add retry",
  plan: "Wrap upload() in a retry.",
  todos: ["Add a helper", "Use it"],
  decisions: [
    {
      question: "Which backoff?",
      options: ["fixed", "exponential (recommended)"],
      pick: "fixed",
      type: "design",
    },
    { question: "Max tries?", options: ["3", "5"], pick: "5" },
  ],
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-plan-idgaf-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  Object.assign(store, {
    plan: undefined,
    planFile: undefined,
    headless: false,
    mode: "plan",
    decisions: [],
  });
  vi.mocked(quizService.askQuestion).mockClear();
  vi.mocked(requestLoopTurnEnd).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPolicyLevels();
  fs.rmSync(dir, { recursive: true, force: true });
});

const planFile = () =>
  fs.readFileSync(
    path.join(dir, ".continuous", "plans", "add-retry.md"),
    "utf8",
  );

describe.each([
  ["the terminal UI", false],
  ["headless and serve", true],
])("PresentPlan decisions at Questions IDGAF in %s", (_name, headless) => {
  beforeEach(() => {
    store.headless = headless;
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions: "idgaf" });
  });

  it("answers the decisions in the file and does not ask about them", async () => {
    const result = await presentPlanTool.run(args);
    const asked = vi
      .mocked(quizService.askQuestion)
      .mock.calls.map(([q]) => q.question);
    expect(asked.some((q) => q.startsWith("Decision "))).toBe(false);
    const text = planFile();
    expect(text).toContain("exponential");
    expect(text).toMatch(/Max tries\?[\s\S]*5/);
    expect(result).toContain("Auto-answered: Which backoff? -> exponential");
    expect(result).toContain("Auto-answered: Max tries? -> 5");
    expect(result).not.toContain("decisions wait");
    expect(store.decisions.map((d) => [d.by, d.source])).toEqual([
      ["system", "Questions: IDGAF"],
      ["system", "Questions: IDGAF"],
    ]);
  });
});

describe("PresentPlan decisions below IDGAF are unchanged", () => {
  it("headless leaves them waiting in the file", async () => {
    store.headless = true;
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions: "permissive" });
    const result = await presentPlanTool.run(args);
    expect(result).toContain("2 decisions wait for the person");
    expect(store.decisions).toHaveLength(0);
  });

  it("the terminal UI asks each decision", async () => {
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions: "cautious" });
    await presentPlanTool.run(args);
    const asked = vi
      .mocked(quizService.askQuestion)
      .mock.calls.map(([q]) => q.question);
    expect(asked.filter((q) => q.startsWith("Decision "))).toHaveLength(2);
  });
});

describe('"Build this plan?" at Questions IDGAF (ID 3)', () => {
  beforeEach(() => {
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions: "idgaf" });
  });

  it("the terminal UI ends the turn with the plan saved and asks nothing", async () => {
    const result = await presentPlanTool.run(args);
    expect(quizService.askQuestion).not.toHaveBeenCalled();
    expect(requestLoopTurnEnd).toHaveBeenCalledTimes(1);
    expect(planFile()).toContain("Add a helper");
    expect(result).toContain("Plan saved to .continuous/plans/add-retry.md");
    expect(result).toContain("End your turn now");
    expect(result).toContain("do not implement anything");
    // Nothing was built: Plan mode stays and the plan is not approved
    expect(store.mode).toBe("plan");
    expect(result).not.toContain("approved");
  });

  it("a plan with no decisions ends the turn too", async () => {
    const { decisions: _none, ...plain } = args;
    await presentPlanTool.run(plain);
    expect(quizService.askQuestion).not.toHaveBeenCalled();
    expect(requestLoopTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("below IDGAF the terminal UI still asks", async () => {
    setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, questions: "permissive" });
    const { decisions: _none, ...plain } = args;
    await presentPlanTool.run(plain);
    const asked = vi
      .mocked(quizService.askQuestion)
      .mock.calls.map(([q]) => q.question);
    expect(asked.some((q) => q.startsWith("Build this plan?"))).toBe(true);
    expect(requestLoopTurnEnd).not.toHaveBeenCalled();
  });
});
