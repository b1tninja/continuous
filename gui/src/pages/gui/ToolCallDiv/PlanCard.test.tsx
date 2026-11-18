import type { ChatHistoryItem, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import {
  newSession,
  setLoop,
  setTaskPlan,
} from "../../../redux/slices/sessionSlice";
import { setPolicyLevel } from "../../../redux/slices/uiSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { createLoop } from "core/util/loopMode";
import { PlanCard } from "./PlanCard";

const PLAN_URI = "file:///Users/user/workspace1/.continuous/plans/add-retry.md";
const FILE =
  "# Add retry\n\nWrap it.\n\n## To-dos\n\n- [ ] Add a helper <!-- id: 1 -->\n- [ ] Use it <!-- id: 2 -->\n";

const toolCallState: ToolCallState = {
  toolCallId: "plan-1",
  toolCall: {
    id: "plan-1",
    type: "function",
    function: { name: BuiltInToolNames.PresentPlan, arguments: "{}" },
  },
  parsedArgs: {
    title: "Add retry",
    plan: "Wrap **upload()** in a retry.",
    todos: ["Add a helper", "Use it"],
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

function history(extra: ChatHistoryItem[] = []): ChatHistoryItem[] {
  return [
    {
      message: { role: "user", content: "Plan a retry" },
      contextItems: [],
    },
    {
      message: { role: "assistant", content: "" },
      contextItems: [],
      toolCallStates: [toolCallState],
    },
    ...extra,
  ];
}

async function setup(items = history()) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers.readFile = async () => FILE;
  // Enough for Build's turn to run to its end.
  ideMessenger.responses["llm/compileChat"] = {
    compiledChatMessages: [{ role: "user", content: "Build" }],
    didPrune: false,
    contextPercentage: 0.1,
  };
  ideMessenger.setChatResponseText("Building.");
  const openFile = vi.fn().mockResolvedValue(undefined);
  ideMessenger.ide.openFile = openFile;
  const store = setupStore({ ideMessenger });
  const model = {
    title: "Test model",
    model: "test-model",
    provider: "anthropic",
    underlyingProviderName: "anthropic",
  };
  // Mount first: the app's listeners settle the session on mount.
  await renderWithProviders(
    <PlanCard toolCallState={toolCallState} historyIndex={1} />,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: model,
        },
        modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [model] },
      } as any),
    );
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "Plan",
        workspaceDirectory: "",
        history: items,
        mode: "plan",
        planFile: PLAN_URI,
      }),
    );
  });
  return { store, openFile };
}

describe("PlanCard", () => {
  it("shows the plan, its to-dos and a link to the file", async () => {
    const { openFile } = await setup();
    expect(screen.getByTestId("plan-card").textContent).toContain("Add retry");
    expect(screen.getByTestId("plan-card-todos").textContent).toContain(
      "Use it",
    );
    fireEvent.click(screen.getByTestId("plan-card-open"));
    expect(openFile).toHaveBeenCalledWith(PLAN_URI);
  });

  describe("in Loop mode", () => {
    const TASK_PLAN = {
      items: [
        { id: "1", text: "Add a helper", status: "pending" as const },
        { id: "2", text: "Use it", status: "pending" as const },
      ],
      updatedAt: new Date().toISOString(),
    };

    it("is a collapsed tile with the round line and the tree, not the plain list", async () => {
      const { store } = await setup();
      await act(async () => {
        const loop = createLoop(TASK_PLAN, {
          now: new Date(),
          sessionTokens: 0,
        });
        store.dispatch(setTaskPlan(TASK_PLAN));
        store.dispatch(
          setLoop({
            ...loop,
            items: loop.items.map((i) =>
              i.id === "1" ? { ...i, status: "done" as const } : i,
            ),
          }),
        );
      });
      expect(screen.queryByTestId("plan-card-todos")).toBeNull();
      expect(screen.getByTestId("plan-card-diff").textContent).toBe("Round 1");
      const root = screen.getByTestId("plan-tree-root");
      expect(root.getAttribute("aria-expanded")).toBe("false");
      expect(root.textContent).toContain("1/2 done");
      // the plan file link and the plan text stay on the tile
      expect(screen.getByTestId("plan-card-open")).toBeTruthy();
      expect(screen.getByTestId("plan-card-body").hasAttribute("open")).toBe(
        false,
      );
      fireEvent.click(root.querySelector("div")!);
      expect(root.getAttribute("aria-expanded")).toBe("true");
    });

    it("keeps the plain list outside a loop", async () => {
      await setup();
      expect(screen.queryByTestId("plan-tree")).toBeNull();
      expect(screen.getByTestId("plan-card-todos")).toBeTruthy();
    });
  });

  describe("decisions", () => {
    const QUESTION = "Which format should formatDate return?";
    const FILE_WITH_DECISIONS =
      "# Add retry\n\nWrap it.\n\n## Decisions\n\n" +
      `- ${QUESTION}\n  - type: scope\n  - options: ISO 8601 | November 8, 2026\n  - pick: ISO 8601\n  - to-dos: 1\n` +
      "- Keep the old endpoint?\n  - pick: yes\n\n" +
      "## To-dos\n\n- [ ] Add a helper <!-- id: 1 -->\n- [ ] Use it <!-- id: 2 -->\n";

    /** Renders the card with the given decisions; captures what it writes. */
    async function setupDecisions(decisions: unknown[]) {
      const ideMessenger = new MockIdeMessenger();
      ideMessenger.responseHandlers.readFile = async () => FILE_WITH_DECISIONS;
      const written: string[] = [];
      ideMessenger.responseHandlers.writeFile = async (data) => {
        written.push(data.contents);
      };
      const store = setupStore({ ideMessenger });
      await renderWithProviders(
        <PlanCard
          toolCallState={{
            ...toolCallState,
            parsedArgs: { ...toolCallState.parsedArgs, decisions },
          }}
          historyIndex={1}
        />,
        { store, mockIdeMessenger: ideMessenger },
      );
      return { written };
    }

    const withOptions = [
      {
        question: QUESTION,
        options: ["ISO 8601", "November 8, 2026"],
        pick: "ISO 8601",
        type: "scope",
        todos: [1],
      },
    ];

    it("lists the decisions with the options as buttons, the pick marked", async () => {
      await setupDecisions(withOptions);
      const decisions = screen.getByTestId("plan-card-decisions");
      expect(decisions.textContent).toContain(QUESTION);
      expect(decisions.textContent).toContain("(scope)");
      expect(decisions.textContent).toContain("To-dos 1 wait on this.");
      const options = screen.getAllByTestId("plan-card-decision-option");
      expect(options.map((o) => o.textContent)).toEqual([
        "ISO 8601 (pick)",
        "November 8, 2026",
      ]);
      expect(screen.queryByTestId("plan-card-decision-answer")).toBeNull();
    });

    it("an option button writes the answer into the plan file and shows it", async () => {
      const { written } = await setupDecisions(withOptions);
      await act(async () => {
        fireEvent.click(screen.getAllByTestId("plan-card-decision-option")[1]);
      });
      await waitFor(() => expect(written).toHaveLength(1));
      const file = written[0];
      expect(file).toContain(`- ${QUESTION}\n`);
      expect(file).toContain("  - answer: November 8, 2026\n");
      // The rest of the file is kept as it was: title, body, the other
      // decision (unanswered) and the to-dos with their ids.
      expect(file).toContain("# Add retry\n\nWrap it.\n");
      expect(file).toContain("- Keep the old endpoint?\n  - pick: yes\n");
      expect(file).toContain("- [ ] Add a helper <!-- id: 1 -->\n");
      expect(file).toContain("- [ ] Use it <!-- id: 2 -->\n");
      expect(
        screen.getByTestId("plan-card-decision-answered").textContent,
      ).toBe("Answer: November 8, 2026");
    });

    it("a decision without options takes a typed answer", async () => {
      const { written } = await setupDecisions([
        { question: "Keep the old endpoint?", pick: "yes" },
      ]);
      expect(screen.queryByTestId("plan-card-decision-option")).toBeNull();
      const input = screen.getByTestId("plan-card-decision-answer");
      await act(async () => {
        fireEvent.change(input, { target: { value: "No, remove it" } });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("plan-card-decision-submit"));
      });
      await waitFor(() => expect(written).toHaveLength(1));
      expect(written[0]).toContain(
        "- Keep the old endpoint?\n  - pick: yes\n  - answer: No, remove it\n",
      );
      expect(
        screen.getByTestId("plan-card-decision-answered").textContent,
      ).toBe("Answer: No, remove it");
    });
  });

  it("Keep planning stays in Plan mode and sends nothing", async () => {
    const { store } = await setup();
    await act(async () => {
      fireEvent.click(screen.getByTestId("plan-card-keep-planning"));
    });
    expect(store.getState().session.mode).toBe("plan");
    expect(store.getState().session.history).toHaveLength(2);
    expect(screen.getByTestId("plan-card-build")).toBeTruthy();
  });

  it("Build switches to Agent mode and sends the build message", async () => {
    const { store } = await setup();
    await act(async () => {
      fireEvent.click(screen.getByTestId("plan-card-build"));
    });
    await waitFor(() =>
      expect(store.getState().session.history.length).toBeGreaterThan(2),
    );
    const state = store.getState().session;
    expect(state.mode).toBe("agent");
    const sent = state.history[2];
    expect(sent.message.role).toBe("user");
    expect(JSON.stringify(sent.editorState)).toContain(
      "Build the plan in .continuous/plans/add-retry.md",
    );
  });

  describe("the budget step", () => {
    const FILE_WITH_BUDGET =
      "# Add retry\n\nWrap it.\n\n## To-dos\n\n- [ ] Add a helper <!-- id: 1 -->\n  budget: 25 turns, 50K tokens\n- [ ] Use it <!-- id: 2 -->\n";

    async function setupBudget(level: "manual" | "cautious" = "cautious") {
      const ideMessenger = new MockIdeMessenger();
      ideMessenger.responseHandlers.readFile = async () => FILE_WITH_BUDGET;
      ideMessenger.responses["llm/compileChat"] = {
        compiledChatMessages: [{ role: "user", content: "Build" }],
        didPrune: false,
        contextPercentage: 0.1,
      };
      ideMessenger.setChatResponseText("Building.");
      const store = setupStore({ ideMessenger });
      const planCall = {
        ...toolCallState,
        parsedArgs: {
          ...toolCallState.parsedArgs,
          todo_details: [{ todo: 1, budget: "25 turns, 50K tokens" }],
        },
      };
      await renderWithProviders(
        <PlanCard toolCallState={planCall} historyIndex={1} />,
        { store, mockIdeMessenger: ideMessenger },
      );
      await act(async () => {
        store.dispatch(setPolicyLevel({ area: "plan", level }));
        store.dispatch(
          newSession({
            sessionId: "s1",
            title: "Plan",
            workspaceDirectory: "",
            history: history(),
            mode: "plan",
            planFile: PLAN_URI,
          }),
        );
      });
      return { store };
    }

    it("is hidden until asked for, and says there is no history", async () => {
      await setupBudget();
      expect(screen.queryByTestId("plan-budget")).toBeNull();
      fireEvent.click(screen.getByTestId("plan-card-budget-toggle"));
      expect(screen.getByTestId("plan-budget")).toBeTruthy();
      expect(screen.getByTestId("plan-budget-proposal").textContent).toMatch(
        /no history/i,
      );
      expect(
        (screen.getByTestId("plan-budget-propose") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      // The planner's line is the number beside its to-do
      expect(
        (screen.getByTestId("plan-budget-tokens-1") as HTMLInputElement).value,
      ).toBe("50000");
      expect(
        (screen.getByTestId("plan-budget-tokens-2") as HTMLInputElement).value,
      ).toBe("");
    });

    it("divides the loop's budget by the strategy and lets a number be edited", async () => {
      await setupBudget();
      fireEvent.click(screen.getByTestId("plan-card-budget-toggle"));
      fireEvent.change(screen.getByTestId("plan-budget-strategy"), {
        target: { value: "equal" },
      });
      // The default reserve is 20%; the planner's line for to-do 1 stands, and
      // to-do 2 gets what it left of the loop's tokens
      expect(
        (screen.getByTestId("plan-budget-reserve") as HTMLInputElement).value,
      ).toBe("20");
      const second = screen.getByTestId(
        "plan-budget-tokens-2",
      ) as HTMLInputElement;
      expect(Number(second.value)).toBeGreaterThan(1_000_000);
      fireEvent.change(second, { target: { value: "90000" } });
      expect(
        (screen.getByTestId("plan-budget-tokens-2") as HTMLInputElement).value,
      ).toBe("90000");
    });

    it("Apply closes the step; Build in a loop writes the budgets and the reserve", async () => {
      const { store } = await setupBudget();
      fireEvent.click(screen.getByTestId("plan-card-budget-toggle"));
      fireEvent.change(screen.getByTestId("plan-budget-strategy"), {
        target: { value: "equal" },
      });
      fireEvent.change(screen.getByTestId("plan-budget-tokens-2"), {
        target: { value: "90000" },
      });
      fireEvent.click(screen.getByTestId("plan-budget-apply"));
      expect(screen.queryByTestId("plan-budget")).toBeNull();
      expect(
        screen.getByTestId("plan-card-budget-summary").textContent,
      ).toContain("equal");
      await act(async () => {
        fireEvent.click(screen.getByTestId("plan-card-build-loop"));
      });
      await waitFor(() => expect(store.getState().session.loop).toBeTruthy());
      const { loop, taskPlan } = store.getState().session;
      expect(taskPlan?.items[0].budget).toEqual({
        turns: 25,
        tokens: 50_000,
        minutes: expect.any(Number),
      });
      expect(taskPlan?.items[1].budget?.tokens).toBe(90_000);
      expect(loop?.reserve?.tokens).toBeGreaterThan(0);
    });

    it("Skip leaves no strategy: no reserve, the planner's line stands below Manual", async () => {
      const { store } = await setupBudget("cautious");
      await act(async () => {
        fireEvent.click(screen.getByTestId("plan-card-build-loop"));
      });
      await waitFor(() => expect(store.getState().session.loop).toBeTruthy());
      const { loop, taskPlan } = store.getState().session;
      expect(loop?.reserve).toBeUndefined();
      expect(taskPlan?.items[0].budget?.turns).toBe(25);
      expect(taskPlan?.items[1].budget).toBeUndefined();
    });

    it("at Manual nothing applies without the person: the planner's line is dropped", async () => {
      const { store } = await setupBudget("manual");
      fireEvent.click(screen.getByTestId("plan-card-budget-toggle"));
      expect(screen.getByTestId("plan-budget-authority").textContent).toContain(
        "Manual",
      );
      fireEvent.click(screen.getByTestId("plan-budget-skip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("plan-card-build-loop"));
      });
      await waitFor(() => expect(store.getState().session.loop).toBeTruthy());
      expect(
        store.getState().session.taskPlan?.items.every((i) => !i.budget),
      ).toBe(true);
    });

    it("at Manual, applying the step is what makes the planner's line count", async () => {
      const { store } = await setupBudget("manual");
      fireEvent.click(screen.getByTestId("plan-card-budget-toggle"));
      fireEvent.click(screen.getByTestId("plan-budget-apply"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("plan-card-build-loop"));
      });
      await waitFor(() => expect(store.getState().session.loop).toBeTruthy());
      expect(store.getState().session.taskPlan?.items[0].budget?.turns).toBe(
        25,
      );
    });
  });

  it("hides the buttons once something was sent after the plan", async () => {
    await setup(
      history([
        {
          message: { role: "user", content: "Smaller steps" },
          contextItems: [],
        },
        {
          message: { role: "assistant", content: "Revising." },
          contextItems: [],
        },
      ]),
    );
    expect(screen.queryByTestId("plan-card-build")).toBeNull();
    expect(screen.queryByTestId("plan-card-keep-planning")).toBeNull();
  });
});
