import { act, screen, waitFor } from "@testing-library/react";
import type { ChatHistoryItem, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { parsePlanFile, serializePlanFile } from "core/util/planFile";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import { setPolicyLevel } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { QuestionPanel } from "./QuestionPanel";

const PLAN_URI = "file:///work/repo/.continuous/plans/add-retry.md";
const DECISIONS = [
  {
    question: "Which backoff?",
    options: ["fixed", "exponential (recommended)"],
    pick: "fixed",
    type: "irreversible" as const,
  },
];
const FILE = serializePlanFile({
  title: "Add retry",
  body: "Wrap it.",
  items: [{ id: "1", status: "pending" as const, text: "Add a helper" }],
  decisions: DECISIONS,
});

const planCall: ToolCallState = {
  toolCallId: "plan-1",
  toolCall: {
    id: "plan-1",
    type: "function",
    function: { name: BuiltInToolNames.PresentPlan, arguments: "{}" },
  },
  parsedArgs: {
    title: "Add retry",
    plan: "Wrap it.",
    todos: ["Add a helper"],
    decisions: DECISIONS,
  },
  status: "done",
  output: [
    {
      name: "Add retry",
      description: ".continuous/plans/add-retry.md",
      content: "Plan saved",
      uri: { type: "file", value: PLAN_URI },
    },
  ],
};

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "Plan a retry" }, contextItems: [] },
  {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [planCall],
  },
];

async function setup(
  questions: "manual" | "cautious" | "permissive" | "idgaf",
) {
  const files = { [PLAN_URI]: FILE } as Record<string, string>;
  const ideMessenger = new MockIdeMessenger();
  const requests: [string, unknown][] = [];
  ideMessenger.responseHandlers.readFile = async (data: any) =>
    files[data.filepath];
  ideMessenger.responseHandlers.writeFile = async (data: any) => {
    files[data.path] = data.contents;
  };
  ideMessenger.responseHandlers["audit/autoAnswer"] = async (data: any) => {
    requests.push(["audit/autoAnswer", data]);
  };
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<QuestionPanel />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(setPolicyLevel({ area: "questions", level: questions }));
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "Plan",
        workspaceDirectory: "",
        history,
        mode: "plan",
        planFile: PLAN_URI,
      }),
    );
  });
  return { files, requests };
}

describe("plan decisions in the Questions panel", () => {
  it.each(["manual", "cautious", "permissive"] as const)(
    "at Questions %s the decision waits as a row",
    async (level) => {
      const { files, requests } = await setup(level);
      await waitFor(() =>
        expect(screen.getAllByTestId("plan-decision")).toHaveLength(1),
      );
      expect(screen.queryByTestId("auto-answered")).toBeNull();
      expect(
        parsePlanFile(files[PLAN_URI]).decisions[0].answer,
      ).toBeUndefined();
      expect(requests.some(([n]) => n === "audit/autoAnswer")).toBe(false);
    },
  );

  it("at Questions IDGAF there is no row: it is answered in the file, with one line", async () => {
    const { files, requests } = await setup("idgaf");
    await waitFor(() =>
      expect(parsePlanFile(files[PLAN_URI]).decisions[0].answer).toBe(
        "exponential",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("auto-answered").textContent).toBe(
        "Auto-answered: Which backoff? -> exponential",
      ),
    );
    // Never a blocking row or a panel
    expect(screen.queryByTestId("plan-decision")).toBeNull();
    expect(screen.queryByTestId("question-panel")).toBeNull();
    expect(requests).toContainEqual([
      "audit/autoAnswer",
      expect.objectContaining({
        answer: "exponential",
        source: "Questions: IDGAF",
      }),
    ]);
  });
});
