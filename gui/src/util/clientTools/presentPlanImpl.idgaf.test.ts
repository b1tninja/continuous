import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { parsePlanFile } from "core/util/planFile";
import { describe, expect, it, vi } from "vitest";
import { ClientToolExtras } from "./callClientTool";
import { presentPlanImpl } from "./presentPlanImpl";

const WS = "file:///work/repo";
const URI = `${WS}/.continuous/plans/add-retry.md`;

function setup(questions: string) {
  const files = new Map<string, string>();
  const ide = {
    getWorkspaceDirs: vi.fn().mockResolvedValue([WS]),
    fileExists: vi.fn(async (uri: string) => files.has(uri)),
    readFile: vi.fn(async (uri: string) => files.get(uri) ?? ""),
    writeFile: vi.fn(async (uri: string, text: string) => {
      files.set(uri, text);
    }),
  };
  const request = vi.fn().mockResolvedValue({ status: "success" });
  const extras = {
    getState: () => ({
      session: {},
      ui: {
        policyLevels: { ...DEFAULT_POLICY_LEVELS, questions },
        policyExtras: {},
      },
      config: { config: {} },
    }),
    dispatch: vi.fn(),
    ideMessenger: { ide, request },
  } as unknown as ClientToolExtras;
  return { files, request, extras };
}

const args = {
  title: "Add retry",
  plan: "Wrap upload() in a retry.",
  todos: ["Add a helper", "Use it"],
  decisions: [
    {
      question: "Which backoff?",
      options: ["fixed", "exponential (recommended)"],
      pick: "fixed",
      type: "irreversible",
    },
    { question: "Max tries?", options: ["3", "5"], pick: "5" },
  ],
};

describe("present_plan decisions outside a loop", () => {
  it("at Questions IDGAF are answered in the file, audited and reported", async () => {
    const x = setup("idgaf");
    const out = await presentPlanImpl(args, "call-1", x.extras);

    expect(
      parsePlanFile(x.files.get(URI)!).decisions.map((d) => [
        d.question,
        d.answer,
      ]),
    ).toEqual([
      ["Which backoff?", "exponential"],
      ["Max tries?", "5"],
    ]);
    const content = String(out.output?.[0].content);
    expect(content).toContain("Auto-answered: Which backoff? -> exponential");
    expect(content).toContain("Auto-answered: Max tries? -> 5");
    expect(x.request).toHaveBeenCalledTimes(2);
    expect(x.request).toHaveBeenCalledWith(
      "audit/autoAnswer",
      expect.objectContaining({
        question: "Which backoff?",
        answer: "exponential",
        source: "Questions: IDGAF",
      }),
    );
  });

  it.each(["manual", "cautious", "automatic", "permissive"])(
    "at Questions %s are left for the person",
    async (questions) => {
      const x = setup(questions);
      const out = await presentPlanImpl(args, "call-1", x.extras);
      expect(
        parsePlanFile(x.files.get(URI)!).decisions.every((d) => !d.answer),
      ).toBe(true);
      expect(x.request).not.toHaveBeenCalled();
      expect(String(out.output?.[0].content)).not.toContain("Auto-answered");
    },
  );
});
