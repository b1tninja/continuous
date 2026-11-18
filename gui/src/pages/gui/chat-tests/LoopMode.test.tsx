import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ChatMessage, PromptLog } from "core";
import { serializeTool } from "core/tools";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  createNewFileTool,
  finishItemTool,
  holdQuestionTool,
  remindMeTool,
  presentPlanTool,
  readFileTool,
  runTerminalCommandTool,
  singleFindAndReplaceTool,
  taskListTool,
} from "core/tools/definitions";
import { renderChatMessage } from "core/util/messageContent";
import { serializePlanFile } from "core/util/planFile";
import { selectActiveTools } from "../../../redux/selectors/selectActiveTools";
import {
  INITIAL_PROFILES_STATE,
  setProfiles,
  setSelectedProfile,
} from "../../../redux/slices/profilesSlice";
import { setLoop, setPlanFile } from "../../../redux/slices/sessionSlice";
import { setPolicyLevel } from "../../../redux/slices/uiSlice";
import { startLoopFromPlan } from "../../../redux/thunks/loop";
import {
  LoopWorktreeOps,
  setLoopWorktreeOps,
} from "../../../util/loopWorktrees";
import { triggerConfigUpdate } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import { getElementByTestId, getMainEditor } from "../../../util/test/utils";
import { Chat } from "../Chat";

/*
 * Loop mode end to end in the chat: the loop seeds its items from a plan
 * file, runs each with the one-item prompt, holds questions in the inbox
 * while other items run, routes the person's answers, holds tool calls that
 * would ask, and re-plans in Plan mode when a round runs dry.
 */

const WORKSPACE = "file:///Users/user/workspace1";
const PLAN_FILE = `${WORKSPACE}/.continuous/plans/build-the-parser.md`;

type Turn = (signal: AbortSignal) => AsyncGenerator<ChatMessage[]>;

function calls(...list: { name: string; args: object }[]): Turn {
  return async function* () {
    yield [
      {
        role: "assistant",
        content: "",
        toolCalls: list.map(({ name, args }, i) => ({
          id: `call-${Math.random().toString(36).slice(2)}-${i}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
    ];
  };
}

const finish = (
  outcome: "done" | "waiting" | "stuck",
  summary: string = outcome,
) => calls({ name: BuiltInToolNames.FinishItem, args: { outcome, summary } });

const ask = (
  question: string,
  kind: "blocking" | "assumption",
  assumption?: string,
  options?: string[],
  type?: string,
) =>
  calls({
    name: BuiltInToolNames.HoldQuestion,
    args: {
      question,
      kind,
      ...(type ? { type } : {}),
      ...(assumption ? { assumption } : {}),
      ...(options ? { options } : {}),
    },
  });

const text = (m: ChatMessage | undefined) => (m ? renderChatMessage(m) : "");

/** A second chat model, for a to-do that names its own (TaskItem.model). */
const OPUS = {
  model: "opus-mock",
  provider: "mock",
  title: "Opus",
  underlyingProviderName: "mock",
};

async function setup(
  todos: (
    string | { text: string; model?: string; files?: string[]; check?: string }
  )[],
) {
  const rendered = await renderWithProviders(<Chat />);
  const { store, ideMessenger } = rendered;
  await act(async () => {
    // A selected profile, as in the IDE: switching the model needs one
    store.dispatch(setProfiles(INITIAL_PROFILES_STATE.profiles));
    store.dispatch(setSelectedProfile("local"));
    triggerConfigUpdate({
      store,
      ideMessenger,
      editConfig(current) {
        const llm = {
          model: "mock",
          provider: "mock",
          title: "Mock LLM",
          underlyingProviderName: "mock",
        };
        current.modelsByRole.chat.push(llm, OPUS);
        current.selectedModelByRole.chat = llm;
        current.tools = [
          readFileTool,
          runTerminalCommandTool,
          createNewFileTool,
          singleFindAndReplaceTool,
          taskListTool,
          presentPlanTool,
          holdQuestionTool,
          remindMeTool,
          finishItemTool,
        ].map(serializeTool) as any;
        return current;
      },
    });
  });

  // An in-memory workspace for the plan file
  const files: Record<string, string> = {
    [PLAN_FILE]: serializePlanFile({
      title: "Build the parser",
      body: "Parse the grammar.",
      items: todos.map((t, i) => ({
        id: String(i + 1),
        status: "pending" as const,
        ...(typeof t === "string" ? { text: t } : t),
      })),
    }),
  };
  const path = (data: any) => data.filepath ?? data.fileUri ?? data.path;
  ideMessenger.responseHandlers["readFile"] = async (data: any) =>
    files[path(data)] ?? "";
  ideMessenger.responseHandlers["writeFile"] = async (data: any) => {
    files[path(data)] = data.contents;
  };
  ideMessenger.responseHandlers["fileExists"] = async (data: any) =>
    path(data) in files;
  ideMessenger.responses["context/getSymbolsForFiles"] = {};
  ideMessenger.responseHandlers["llm/compileChat"] = async ({
    messages,
  }: any) => ({
    compiledChatMessages: messages,
    didPrune: false,
    contextPercentage: 0.1,
  });

  // The model: scripted turns in order; every request is recorded
  const turns: Turn[] = [];
  const requests: {
    messages: ChatMessage[];
    tools: string[];
    /** The title of the model the request went to */
    title?: string;
  }[] = [];
  ideMessenger.llmStreamChat = async function* (msg: any, signal) {
    requests.push({
      messages: msg.messages,
      // What the gui offered with this request
      tools: selectActiveTools(store.getState()).map((t) => t.function.name),
      title: msg.title,
    });
    const turn = turns.shift();
    if (!turn) throw new Error("no turn scripted");
    yield* turn(signal);
    return undefined as PromptLog | undefined;
  };

  const start = async (
    options: { parallel?: boolean; fallbackCheck?: string } = {},
  ) => {
    await act(async () => {
      // Waves need a level that does not ask before each edit: Plan edits
      // Permissive is Unattended, and the switch is on from the start
      if (options.parallel) {
        store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
      }
      store.dispatch(setPlanFile(PLAN_FILE));
      await store.dispatch(
        startLoopFromPlan({
          planFile: PLAN_FILE,
          parallel: options.parallel,
          fallbackCheck: options.fallbackCheck,
        }),
      );
    });
  };
  /** The prompt the loop sent with request n (the last user message, without an item's plan block). */
  const prompt = (n: number) =>
    text(
      requests[n]?.messages
        .filter((m) => m.role === "user" && !text(m).startsWith("<task_list>"))
        .at(-1),
    )
      .split("<task_list>")[0]
      .trimEnd();
  const loop = () => store.getState().session.loop!;
  const itemStatus = (id: string) =>
    loop().items.find((i) => i.id === id)?.status;
  return {
    ...rendered,
    files,
    turns,
    requests,
    start,
    prompt,
    loop,
    itemStatus,
  };
}

function answerInInbox(questionId: string, answer: string) {
  const row = document.querySelector(
    `[data-testid=loop-question-${questionId}]`,
  )!;
  const input = row.querySelector<HTMLInputElement>(
    "[data-testid=loop-answer-input]",
  )!;
  fireEvent.change(input, { target: { value: answer } });
  fireEvent.click(row.querySelector("[data-testid=loop-answer-send]")!);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

describe("Loop mode", () => {
  test("a loop is one card above the input, named by its plan, with the plan inside it", async () => {
    const h = await setup(["Pick the grammar", "Write the lexer"]);
    h.turns.push(
      ask("Item 'Pick the grammar': ABNF or PEG?", "blocking"),
      finish("waiting", "needs the grammar choice"),
      finish("done", "lexer written"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));

    const panel = document.querySelector("[data-testid=loops-panel]")!;
    // No separate "Loops" heading: the card is the loop
    expect(panel.textContent).not.toContain("Loops");
    // Named by its plan, not just "Loop"
    expect(
      panel.querySelector("[data-testid=loop-status]")!.textContent,
    ).toContain("Build the parser");
    // The plan is in the loop's card, shown open
    const controls = panel.querySelector<HTMLDetailsElement>(
      "[data-testid=loop-controls]",
    )!;
    expect(controls.open).toBe(true);
    expect(controls.textContent).toContain("Pick the grammar");
    // And not a second time in a separate task list
    expect(document.querySelector("[data-testid=task-list-panel]")).toBeNull();
  });

  test("a held question with choices shows them in the Questions panel, and a choice answers it", async () => {
    const h = await setup(["Pick the grammar"]);
    h.turns.push(
      ask("Item 'Pick the grammar': ABNF or PEG?", "blocking", undefined, [
        "ABNF",
        "PEG",
        "Both",
      ]),
      finish("waiting", "needs the grammar choice"),
      finish("done", "grammar picked"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));

    // The model's choices were kept, and they appear in their own panel
    expect(h.loop().questions[0].options).toEqual(["ABNF", "PEG", "Both"]);
    const panel = document.querySelector("[data-testid=needs-you-tray]")!;
    expect(panel.textContent).toContain("Needs you");
    expect(
      panel.querySelector("[data-testid=needs-you-pager]")!.textContent,
    ).toBe("1 of 1");
    expect(
      [...panel.querySelectorAll("[data-testid=loop-choice-option]")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["ABNF", "PEG", "Both"]);
    // The inbox does not point at the panel: the panel is on screen
    expect(
      document.querySelector("[data-testid=loop-questions-pointer]"),
    ).toBeNull();

    // Selecting a choice only marks it: nothing is sent until Answer
    await act(async () =>
      fireEvent.click(
        panel.querySelectorAll("[data-testid=loop-choice-option]")[1],
      ),
    );
    expect(
      panel
        .querySelectorAll("[data-testid=loop-choice-option]")[1]
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(h.loop().questions[0].answerId).toBeUndefined();
    expect(h.loop().status).toBe("waiting");
    await act(async () =>
      fireEvent.click(panel.querySelector("[data-testid=loop-choice-apply]")!),
    );
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.prompt(2)).toContain(": PEG");
    // Nothing waits any more: the tray is one quiet line
    expect(
      document.querySelector("[data-testid=needs-you-question]"),
    ).toBeNull();
    expect(
      document
        .querySelector("[data-testid=needs-you-tray]")!
        .getAttribute("data-quiet"),
    ).toBe("true");
  });

  test("Other opens a field for an answer of your own", async () => {
    const h = await setup(["Pick the grammar"]);
    h.turns.push(
      ask("Item 'Pick the grammar': ABNF or PEG?", "blocking", undefined, [
        "ABNF",
        "PEG",
      ]),
      finish("waiting", "needs the grammar choice"),
      finish("done", "grammar picked"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));

    expect(
      document.querySelector("[data-testid=loop-choice-other-input]"),
    ).toBeNull();
    await act(async () =>
      fireEvent.click(
        document.querySelector("[data-testid=loop-choice-other]")!,
      ),
    );
    const input = document.querySelector<HTMLInputElement>(
      "[data-testid=loop-choice-other-input]",
    )!;
    await act(async () =>
      fireEvent.change(input, {
        target: { value: "Neither: use a hand parser" },
      }),
    );
    await act(async () =>
      fireEvent.click(
        document.querySelector("[data-testid=loop-choice-apply]")!,
      ),
    );
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.prompt(2)).toContain("Neither: use a hand parser");
  });

  test("a plan's decisions are answered in the Questions panel, and the answer lands in the plan file", async () => {
    const h = await setup([]);
    h.turns.push(
      calls({
        name: BuiltInToolNames.PresentPlan,
        args: {
          title: "Build the parser",
          plan: "Parse the grammar.",
          todos: ["Write the lexer", "Add tests"],
          decisions: [
            {
              question: "Where does the fix land?",
              options: ["Workspace copy", "Upstream", "Both"],
              pick: "Workspace copy",
              type: "scope",
              todos: [1],
            },
          ],
        },
      }),
    );
    await pickMode(h, "mode-option-loop");
    await send("Plan the parser");

    // Plan edits Cautious: the first plan waits, and its decision is a question
    const panel = await waitFor(() => {
      const el = document.querySelector("[data-testid=question-panel]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(panel.textContent).toContain("1 question for you");
    expect(panel.textContent).toContain("Where does the fix land?");
    expect(panel.textContent).toContain("Workspace copy (recommended)");
    // The card neither points at the panel nor repeats the question
    expect(
      document.querySelector("[data-testid=plan-card-decisions-pointer]"),
    ).toBeNull();
    expect(
      document.querySelector("[data-testid=plan-card-decisions]"),
    ).toBeNull();

    await act(async () =>
      fireEvent.click(
        panel.querySelectorAll("[data-testid=plan-decision-option]")[1],
      ),
    );
    await act(async () =>
      fireEvent.click(
        panel.querySelector("[data-testid=plan-decision-apply]")!,
      ),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-testid=question-panel]")).toBeNull(),
    );
    // The harness seeds one plan file; the presented plan is the new one
    const file = Object.entries(h.files).find(([k]) =>
      k.endsWith("build-the-parser-2.md"),
    )![1];
    expect(file).toContain("Where does the fix land?");
    expect(file).toContain("Upstream");
  });

  test("a question without choices keeps the free-text field", async () => {
    const h = await setup(["Pick the grammar"]);
    h.turns.push(
      ask("Item 'Pick the grammar': ABNF or PEG?", "blocking"),
      finish("waiting", "needs the grammar choice"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(
      document.querySelector("[data-testid=loop-answer-input]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid=loop-choice-option]"),
    ).toBeNull();
  });

  test("seeds the items, parks a blocking question while the others run, and requeues it when answered", async () => {
    const h = await setup(["Pick the grammar", "Write the lexer", "Add tests"]);
    h.turns.push(
      // Item 1 asks a blocking question and reports waiting
      ask("Item 'Pick the grammar': ABNF or PEG? No default fits.", "blocking"),
      finish("waiting", "needs the grammar choice"),
      // Items 2 and 3 run meanwhile
      finish("done", "lexer written"),
      finish("done", "tests added"),
      // Item 1 again, with the answer
      finish("done", "grammar picked"),
    );
    await h.start();

    expect(h.loop().items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(h.itemStatus("1")).toBe("waiting");
    expect(h.itemStatus("2")).toBe("done");
    expect(h.itemStatus("3")).toBe("done");
    expect(h.prompt(0)).toContain("only this item: Pick the grammar");
    expect(h.prompt(0)).toContain(".continuous/plans/build-the-parser.md");
    expect(h.prompt(2)).toContain("only this item: Write the lexer");
    // The loop's tools are offered; the task list is the loop's
    expect(h.requests[0].tools).toContain(BuiltInToolNames.HoldQuestion);
    expect(h.requests[0].tools).not.toContain(BuiltInToolNames.TaskList);
    // The task list shows where each item is
    expect(
      h.store.getState().session.taskPlan!.items.map((i) => i.status),
    ).toEqual(["blocked", "completed", "completed"]);

    expect(
      document.querySelector("[data-testid=loop-status]")!.textContent,
    ).toContain("paused until you answer");
    await act(async () => answerInInbox("q1", "PEG"));

    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(h.prompt(4)).toContain("only this item: Pick the grammar");
    expect(h.prompt(4)).toContain(": PEG");
    expect(h.loop().answers[0]).toMatchObject({
      route: "requeue",
      delivered: true,
    });
    // Off again once the loop is done
    expect(
      selectActiveTools(h.store.getState()).map((t) => t.function.name),
    ).not.toContain(BuiltInToolNames.FinishItem);
  });

  test("an answer given while its item runs is steered in at the next tool boundary", async () => {
    const h = await setup(["Write the lexer"]);
    let release = () => {};
    let readStarted = () => {};
    const reading = new Promise<void>((r) => (readStarted = r));
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      readStarted();
      await new Promise<void>((r) => (release = r));
      return {
        contextItems: [{ name: "a.ts", description: "a.ts", content: "src" }],
      };
    };
    h.turns.push(
      ask(
        "Item 'Write the lexer': name it lexer.ts?",
        "assumption",
        "lexer.ts",
      ),
      calls({ name: BuiltInToolNames.ReadFile, args: { filepath: "a.ts" } }),
      finish("done", "lexer.ts written"),
    );
    await h.start();
    await reading;
    expect(h.itemStatus("1")).toBe("running");

    await act(async () => answerInInbox("q1", "Call it tokens.ts"));
    expect(h.loop().answers[0].route).toBe("steer");
    expect(h.store.getState().session.queuedMessages[0]).toMatchObject({
      steer: true,
      loopAnswerId: "a1",
    });

    await act(async () => release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    // The request after the read carries the answer, in the same run
    expect(h.prompt(2)).toContain("Call it tokens.ts");
    expect(h.loop().answers[0].delivered).toBe(true);
    expect(h.store.getState().session.queuedMessages).toEqual([]);
    expect(h.requests).toHaveLength(3);
  });

  test("a round that runs dry is re-planned in Plan mode, and accepting the card starts the next round", async () => {
    const h = await setup(["Write the lexer", "Add tests"]);
    // Every re-plan waits for the person: what this test is about
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "manual" }));
    });
    h.turns.push(
      finish("done", "lexer written"),
      finish("stuck", "no test runner installed"),
      // The re-plan: a read-only turn that presents the updated plan
      calls({
        name: BuiltInToolNames.PresentPlan,
        args: {
          title: "Build the parser",
          plan: "Parse the grammar.",
          todos: ["Write the lexer", "Install vitest", "Add tests"],
        },
      }),
      finish("done", "vitest installed"),
      finish("done", "tests added"),
    );
    await h.start();

    await waitFor(() => expect(h.loop().status).toBe("awaiting_plan"));
    // The card says why it asks and what changed, not just the whole document
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid=plan-card-diff]"),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector("[data-testid=plan-card-diff]")!.textContent,
    ).toContain("2 kept, 1 added, 0 dropped");
    // The to-dos are the plan tree now: it opens by itself while the plan waits
    const tree = document.querySelector("[data-testid=plan-tree]")!;
    expect(
      tree
        .querySelector("[data-testid=plan-tree-root]")!
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(tree.textContent).toContain("Install vitest");
    expect(
      document.querySelector("[data-testid=needs-you-plan-reason]")!
        .textContent,
    ).toContain("Why you are asked");
    // State is an icon and a word for a screen reader, not a bracket mark
    const rows = [...tree.querySelectorAll("[data-testid^=plan-tree-item-]")];
    const row = (text: string) =>
      rows.find((r) => r.textContent?.includes(text))?.textContent;
    expect(
      tree.querySelector("[data-testid=plan-tree-fold-done]")!.textContent,
    ).toContain("1 done");
    expect(row("Install vitest")).toContain("to do");
    expect(row("Install vitest")).toContain("new");
    expect(row("Add tests")).toContain("failed");
    expect(h.store.getState().session.mode).toBe("plan");
    expect(h.prompt(2)).toContain("Re-evaluate the plan");
    expect(h.prompt(2)).toContain("(failed: no test runner installed)");
    expect(h.prompt(2)).toContain('title "Build the parser"');
    // Plan mode's turn has no loop tools and cannot write
    expect(h.requests[2].tools).not.toContain(BuiltInToolNames.FinishItem);
    expect(h.requests[2].tools).not.toContain(
      BuiltInToolNames.RunTerminalCommand,
    );

    const cont = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-testid=needs-you-accept-plan]",
      );
      expect(el).not.toBeNull();
      return el!;
    });
    await act(async () => cont.click());

    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(h.loop().round).toBe(2);
    // The finished item kept its id and stayed done; only the rest ran
    expect(h.prompt(3)).toContain("only this item: Install vitest");
    expect(h.prompt(4)).toContain("only this item: Add tests");
    expect(h.requests).toHaveLength(5);
  });

  test("a call that would ask is held as an approval question, and runs once allowed", async () => {
    const h = await setup(["Run the build"]);
    let ran = 0;
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      ran++;
      return {
        contextItems: [{ name: "out", description: "out", content: "ok" }],
      };
    };
    const build = calls({
      name: BuiltInToolNames.RunTerminalCommand,
      args: { command: "npm run build", waitForCompletion: true },
    });
    h.turns.push(
      build,
      finish("waiting", "needs approval for the build"),
      build,
      finish("done", "built"),
    );
    await h.start();

    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(ran).toBe(0);
    expect(h.loop().questions[0]).toMatchObject({ kind: "approval" });
    // The inbox says what would run, so it can be answered from there
    expect(h.loop().questions[0].question).toContain("npm run build");
    expect(h.requests[1].messages.map(text).join(" ")).toContain(
      "needs the person's approval",
    );

    await act(async () => {
      fireEvent.click(document.querySelector("[data-testid=loop-approve]")!);
    });
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(ran).toBe(1);
    expect(h.loop().grants).toEqual([]);
  });

  test("each item starts in a fresh context, with the earlier items' notes and the person's standing instructions", async () => {
    const h = await setup(["Write the lexer", "Add tests"]);
    let release = () => {};
    let readStarted = () => {};
    const reading = new Promise<void>((r) => (readStarted = r));
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      readStarted();
      await new Promise<void>((r) => (release = r));
      return {
        contextItems: [{ name: "a.ts", description: "a.ts", content: "src" }],
      };
    };
    h.turns.push(
      calls({ name: BuiltInToolNames.ReadFile, args: { filepath: "a.ts" } }),
      calls({
        name: BuiltInToolNames.FinishItem,
        args: {
          outcome: "done",
          summary: "lexer written",
          notes: "Run the tests with npm test -- --run",
        },
      }),
      finish("done", "tests added"),
    );
    await h.start();
    await reading;

    // A note for every item, given while item 1 runs
    // The loop's settings are behind the gear on the status line
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-testid=loop-settings-toggle]")!,
      );
    });
    await act(async () => {
      fireEvent.change(
        document.querySelector("[data-testid=loop-plan-note]")!,
        { target: { value: "Never edit generated files" } },
      );
      fireEvent.click(document.querySelector("[data-testid=loop-standing]")!);
    });
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-testid=loop-plan-note-send]")!,
      );
    });
    expect(h.loop().answers[0].route).toBe("standing");
    expect(
      document.querySelector("[data-testid=loop-standing-list]")!.textContent,
    ).toContain("Never edit generated files");

    await act(async () => release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");

    // Item 2's request: none of item 1's turns, but its notes and the instruction
    const all = h.requests[2].messages.map(text).join(" ");
    expect(h.prompt(2)).toContain("only this item: Add tests");
    expect(all).not.toContain("only this item: Write the lexer");
    // The notes and the instruction ride in the plan block after the item
    // prompt, with every item's slot and the running item marked
    const full = text(
      h.requests[2].messages.filter((m) => m.role === "user").at(-1),
    );
    const block = full.slice(full.indexOf("<task_list>"));
    expect(block.startsWith("<task_list>")).toBe(true);
    expect(block).toContain("[x] 1. Write the lexer");
    expect(block).toContain("[>] 2. Add tests  <- this item");
    expect(block).toContain("Run the tests with npm test -- --run");
    expect(block).toContain("Never edit generated files");
    expect(h.prompt(2)).not.toContain("Run the tests with npm test -- --run");
    // The chat still shows every turn
    const shown = h.store
      .getState()
      .session.history.map((i) => text(i.message))
      .join(" ");
    expect(shown).toContain("only this item: Write the lexer");
  });

  test("with Plan edits Permissive the loop fixes forward: a failed item's repair starts the next round without the card", async () => {
    const h = await setup(["Write the lexer", "Add tests"]);
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    h.turns.push(
      finish("done", "lexer written"),
      finish("stuck", "no test runner installed"),
      calls({
        name: BuiltInToolNames.PresentPlan,
        args: {
          title: "Build the parser",
          plan: "Parse the grammar.",
          todos: ["Write the lexer", "Install vitest", "Add tests"],
        },
      }),
      finish("done", "vitest installed"),
      finish("done", "tests added"),
    );
    await h.start();
    expect(h.loop().autonomy).toBe("unattended");
    expect(h.loop().budget.maxRounds).toBe(10);
    expect(h.loop().strategy).toBe("fix-forward");

    // Nobody clicks Continue the loop
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    // The failed item got a re-plan of its own, which counts as a round
    expect(h.prompt(2)).toContain("failed: Add tests");
    expect(h.prompt(2)).toContain("Re-plan this item only");
    expect(h.loop().round).toBe(2);
    expect(h.loop().replanReason).toBe(
      "The repair keeps the failed item and adds 1 to-do for it.",
    );
    expect(h.prompt(3)).toContain("only this item: Install vitest");
  });

  test("with Questions IDGAF an irreversible question is answered by the system and the loop goes on", async () => {
    const h = await setup(["Drop the old table", "Add tests"]);
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "questions", level: "idgaf" }));
    });
    h.turns.push(
      ask(
        "Drop the old table?",
        "blocking",
        undefined,
        ["Keep it", "Drop it (recommended)"],
        "irreversible",
      ),
      finish("done", "dropped"),
      finish("done", "tests added"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    // Never a panel, never waiting; the record names the system and the setting
    expect(document.querySelector("[data-testid=question-panel]")).toBeNull();
    expect(h.loop().questions[0].autoAnswer).toEqual({
      text: "Drop it",
      by: "system",
      source: "Questions: IDGAF",
    });
    expect(h.loop().autoDecisions?.[0].text).toBe(
      "Auto-answered: Drop the old table? -> Drop it",
    );
    // The agent was told the answer in the tool result
    expect(JSON.stringify(h.requests[1].messages)).toContain(
      "Answered automatically (Questions: IDGAF): Drop it",
    );
  });

  test("with Questions Cautious the same irreversible question waits in the tray", async () => {
    const h = await setup(["Drop the old table"]);
    h.turns.push(
      ask(
        "Drop the old table?",
        "blocking",
        undefined,
        ["Keep it", "Drop it (recommended)"],
        "irreversible",
      ),
      finish("waiting", "needs the decision"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(h.loop().questions[0].answerId).toBeUndefined();
    expect(h.loop().autoDecisions).toBeUndefined();
    // In a loop the question is in the Needs you tray, not the panel
    expect(
      document.querySelector("[data-testid=needs-you-question]"),
    ).not.toBeNull();
  });

  test("with Questions Permissive a plan's open decisions are answered in the plan file by the system", async () => {
    const h = await setup(["Build the store"]);
    h.files[PLAN_FILE] = serializePlanFile({
      title: "Build the parser",
      body: "Parse the grammar.",
      items: [{ id: "1", status: "pending" as const, text: "Build the store" }],
      decisions: [
        {
          question: "Which store?",
          options: ["sqlite", "postgres (recommended)"],
          pick: "sqlite",
          todos: [1],
        },
      ],
    });
    await act(async () => {
      h.store.dispatch(
        setPolicyLevel({ area: "questions", level: "permissive" }),
      );
    });
    h.turns.push(finish("done", "built"));
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.files[PLAN_FILE]).toContain("postgres");
    expect(h.loop().autoDecisions?.[0]).toMatchObject({
      kind: "question",
      by: "system",
      source: "Questions: Permissive",
      text: "Auto-answered: Which store? -> postgres",
    });
    expect(document.querySelector("[data-testid=question-panel]")).toBeNull();
  });

  test("Permissive on Plan edits does not start a timer: a question waits until you answer", async () => {
    const h = await setup(["Pick the database"]);
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    h.turns.push(
      ask("Item 'Pick the database': Postgres or SQLite?", "blocking"),
      finish("waiting", "needs the database choice"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(
      document.querySelector("[data-testid=loop-status]")!.textContent,
    ).toContain("paused until you answer");
    // Not confirmed on the person's behalf: still in the inbox
    expect(h.loop().questions[0].answerId).toBeUndefined();
    expect(
      document.querySelector("[data-testid=loop-question-q1]"),
    ).not.toBeNull();
  });

  test("moving Plan edits or Questions changes the running loop", async () => {
    const h = await setup(["Pick the grammar"]);
    h.turns.push(
      ask("Item 'Pick the grammar': ABNF or PEG?", "blocking"),
      finish("waiting", "needs the grammar"),
    );
    await h.start();
    // The defaults: Plan edits and Questions are Cautious
    expect(h.loop().policy).toMatchObject({
      plan: "cautious",
      questions: "cautious",
    });
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    // The loop's settings are behind the gear on the status line
    await act(async () => {
      fireEvent.click(
        document.querySelector("[data-testid=loop-settings-toggle]")!,
      );
    });
    expect(
      document.querySelector("[data-testid=loop-policy]")!.textContent,
    ).toContain("Plan Cautious");

    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    await waitFor(() => expect(h.loop().policy?.plan).toBe("permissive"));
    expect(h.loop().autonomy).toBe("unattended");
    expect(
      document.querySelector("[data-testid=loop-policy]")!.textContent,
    ).toContain("Plan Permissive");

    // The strategy picker is independent of the levels
    const strategy = document.querySelector<HTMLSelectElement>(
      "[data-testid=loop-strategy]",
    )!;
    await act(async () => {
      fireEvent.change(strategy, { target: { value: "check-in" } });
    });
    expect(h.loop()).toMatchObject({
      strategy: "check-in",
      strategyPicked: true,
    });
  });

  test("a failed model request stops the loop as an error, not as the person's Stop", async () => {
    const h = await setup(["Write the lexer"]);
    h.turns.push(async function* () {
      throw new Error("the server closed the connection");
    });
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("error");
    expect(h.loop().stopDetail).toContain("The model request failed");
    expect(h.itemStatus("1")).toBe("pending");
  });

  test("an overloaded request is retried without stopping the loop", async () => {
    const h = await setup(["Write the lexer"]);
    h.turns.push(
      async function* () {
        throw new Error("Overloaded");
      },
      finish("done", "lexer written"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().stopReason).toBe("done"), {
      timeout: 15_000,
    });
    expect(h.itemStatus("1")).toBe("done");
    expect(h.requests).toHaveLength(2);
  }, 20_000);

  async function startWithTurnLimit(h: Awaited<ReturnType<typeof setup>>) {
    // The first read holds the run open while the limit is set
    let release = () => {};
    let started = () => {};
    const firstRead = new Promise<void>((r) => (started = r));
    let reads = 0;
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      reads++;
      if (reads === 1) {
        started();
        await new Promise<void>((r) => (release = r));
      }
      return {
        contextItems: [{ name: "a", description: "a", content: "src" }],
      };
    };
    await h.start();
    await firstRead;
    await act(async () => {
      h.store.dispatch(
        setLoop({
          ...h.loop(),
          budget: { ...h.loop().budget, maxItemTurns: 2, maxRounds: 1 },
        }),
      );
    });
    await act(async () => release());
    return () => reads;
  }

  const read = (filepath: string) =>
    calls({ name: BuiltInToolNames.ReadFile, args: { filepath } });

  test("at its turn limit an item may only report", async () => {
    const h = await setup(["Write the lexer"]);
    h.turns.push(read("a.ts"), read("b.ts"), finish("done", "wrapped up"));
    const reads = await startWithTurnLimit(h);
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    expect(reads()).toBe(1);
    expect(h.requests[2].messages.map(text).join(" ")).toContain(
      "requests on this item, so this call was not run",
    );
  });

  test("an item that keeps going past its limit is ended as stuck", async () => {
    const h = await setup(["Write the lexer"]);
    h.turns.push(...Array.from({ length: 12 }, (_, i) => read(`f${i}.ts`)));
    const reads = await startWithTurnLimit(h);
    await waitFor(() => expect(h.loop().status).toBe("stopped"), {
      timeout: 15_000,
    });
    expect(reads()).toBe(1);
    expect(h.requests).toHaveLength(12);
    expect(h.itemStatus("1")).toBe("failed");
    expect(h.loop().items[0].summary).toBe(
      "Ended after 12 requests without reporting.",
    );
    expect(h.loop().stopReason).toBe("rounds");
  }, 20_000);

  test("past its limit an item can still write what it researched", async () => {
    const h = await setup(["Write the report"]);
    h.turns.push(
      read("a.ts"),
      read("b.ts"),
      calls({
        name: BuiltInToolNames.RunTerminalCommand,
        args: { command: "npm test" },
      }),
      finish("done", "written"),
    );
    // Not read-only, so it is not refused at the limit; policy still holds it
    await startWithTurnLimit(h);
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(h.loop().questions[0].kind).toBe("approval");
    expect(h.requests[3].messages.map(text).join(" ")).not.toContain(
      "Stop reading and searching. Write what the item needs now, in as few calls as you can, then call finish_item: outcome done",
    );
  });

  test("a tool call cut off at the output limit is not run, and the model is told to write in parts", async () => {
    const h = await setup(["Write the report"]);
    let called = 0;
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      called++;
      return {
        contextItems: [{ name: "r", description: "r", content: "created" }],
      };
    };
    const cutOff: Turn = async function* () {
      yield [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "cut-off",
              type: "function" as const,
              function: {
                name: BuiltInToolNames.ReadFile,
                arguments: '{"filepath":"big.md","contents":"line 1',
              },
            },
          ],
        },
      ];
    };
    h.turns.push(cutOff, finish("done", "written in parts"));
    await h.start();
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    await waitFor(() => expect(h.itemStatus("1")).not.toBe("running"));
    expect(called).toBe(0);
    expect(h.requests[1].messages.map(text).join(" ")).toContain(
      "cut off at the output limit",
    );
    // The partial arguments are not kept or sent back: invalid JSON there can
    // fail a provider, and they would be re-sent with every later request
    const stored = h.store
      .getState()
      .session.history.flatMap((i) => i.toolCallStates ?? [])
      .find((tc) => tc.toolCallId === "cut-off")!;
    expect(stored.toolCall.function.arguments).toBe("{}");
    expect(stored.parsedArgs).toEqual({});
    expect(h.requests[1].messages.map(text).join(" ")).not.toContain("line 1");
  });

  test("a call repeated with no file change is refused once, then the run ends as stuck", async () => {
    const h = await setup(["Run the tests"]);
    let runs = 0;
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      runs++;
      return {
        contextItems: [{ name: "r", description: "r", content: "1 failed" }],
      };
    };
    const again = () =>
      calls({ name: BuiltInToolNames.ReadFile, args: { filepath: "a.ts" } });
    h.turns.push(again(), again(), again(), again(), again());
    await h.start();
    await waitFor(() => expect(h.itemStatus("1")).toBe("failed"));
    expect(runs).toBe(3);
    expect(h.requests[4].messages.map(text).join(" ")).toContain(
      "with no file change in between",
    );
    expect(h.loop().items[0].summary).toContain("Kept repeating read_file");
  });

  test("the same call after a file change is not counted as a repeat", async () => {
    const h = await setup(["Fix the test"]);
    let runs = 0;
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      runs++;
      return {
        contextItems: [{ name: "r", description: "r", content: "output" }],
      };
    };
    const test = () =>
      calls({ name: BuiltInToolNames.ReadFile, args: { filepath: "a.ts" } });
    const edit = (n: number) =>
      calls({
        name: BuiltInToolNames.CreateNewFile,
        args: { filepath: `new${n}.ts`, contents: "x" },
      });
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "tools", level: "idgaf" }));
    });
    h.ideMessenger.responseHandlers["tools/evaluatePolicy"] = async () => ({
      policy: "allowedWithoutPermission",
      source: "idgaf",
    });
    h.turns.push(
      test(),
      test(),
      test(),
      edit(1),
      test(),
      test(),
      test(),
      finish("done", "fixed"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().stopReason).toBe("done"), {
      timeout: 15_000,
    });
    expect(h.requests).toHaveLength(8);
    expect(runs).toBe(7);
  }, 20_000);

  test("an approved write still runs when the model rewrites it with different text", async () => {
    const h = await setup(["Write the report"]);
    let written = 0;
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      written++;
      return {
        contextItems: [{ name: "r", description: "r", content: "created" }],
      };
    };
    const write = (contents: string) =>
      calls({
        name: BuiltInToolNames.CreateNewFile,
        args: { filepath: "report.md", contents },
      });
    h.turns.push(
      write("first draft"),
      finish("waiting", "needs approval to write"),
      write("second draft, reworded"),
      finish("done", "written"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(written).toBe(0);
    await act(async () => {
      fireEvent.click(document.querySelector("[data-testid=loop-approve]")!);
    });
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    expect(written).toBe(1);
    expect(h.loop().questions).toHaveLength(1);
  });

  test("Stop stops the loop with the item back to pending, and Resume goes on", async () => {
    const h = await setup(["Write the lexer"]);
    h.turns.push(async function* (signal) {
      yield [{ role: "assistant", content: "Working" }];
      await new Promise<void>((r) =>
        signal.addEventListener("abort", () => r(), { once: true }),
      );
    }, finish("done"));
    await h.start();
    await waitFor(() =>
      expect(h.store.getState().session.isStreaming).toBe(true),
    );
    const { cancelStream } = await import("../../../redux/thunks/cancelStream");
    await act(async () => {
      await h.store.dispatch(cancelStream());
    });
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("stopped");
    expect(h.itemStatus("1")).toBe("pending");

    await act(async () => {
      fireEvent.click(document.querySelector("[data-testid=loop-resume]")!);
    });
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
  });

  test("the controls edit the limits, skip a waiting item and run a done one again", async () => {
    const h = await setup(["Pick the grammar", "Write the lexer"]);
    // Every re-plan waits for the person: what this test is about
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "manual" }));
    });
    h.turns.push(
      ask("Item 'Pick the grammar': ABNF or PEG?", "blocking"),
      finish("waiting", "needs the grammar"),
      finish("done", "lexer written"),
      finish("done", "lexer checked"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    const el = (id: string) =>
      document.querySelector(`[data-testid=${id}]`) as HTMLElement;

    // The limits are in the settings dialog behind the gear, and stay out of
    // sight there until asked for
    expect(el("loop-settings")).toBeNull();
    await act(async () => fireEvent.click(el("loop-settings-toggle")));
    expect(el("loop-settings")).not.toBeNull();
    expect(el("loop-limit-rounds")).toBeNull();
    await act(async () => fireEvent.click(el("loop-budget-toggle")));
    expect(el("loop-limit-rounds")).not.toBeNull();

    // The limits: core refuses what is out of bounds, and nothing changes
    await act(async () => {
      fireEvent.change(el("loop-limit-rounds"), { target: { value: "2" } });
      fireEvent.change(el("loop-limit-tokens"), { target: { value: "5" } });
      fireEvent.click(el("loop-limits-apply"));
    });
    await waitFor(() =>
      expect(el("loop-controls-error").textContent).toContain(
        "maxTokens must be 0 (no limit) or an integer from 10000",
      ),
    );
    expect(h.loop().budget.maxRounds).toBe(3);
    await act(async () => {
      fireEvent.change(el("loop-limit-tokens"), { target: { value: "0" } });
      fireEvent.change(el("loop-limit-minutes"), { target: { value: "30" } });
      fireEvent.click(el("loop-limits-apply"));
    });
    await waitFor(() =>
      expect(h.loop().budget).toMatchObject({
        maxRounds: 2,
        maxTokens: 0,
        maxWallMs: 30 * 60_000,
      }),
    );
    // Applied: the fields go away and what is left shows, with a run count
    // per task
    await waitFor(() => expect(el("loop-limit-rounds")).toBeNull());
    expect(el("loop-usage-rounds").textContent).toContain("Round 1 of 2");
    expect(el("loop-usage-tokens").textContent).toContain("used");
    expect(el("loop-usage-time").textContent).toContain("left of 30m");
    expect(el("loop-usage-totals").textContent).toContain("done");
    expect(el("loop-runs-1").textContent).toMatch(/\d+ runs?/);
    expect(el("loop-controls-error")).toBeNull();
    await act(async () => {
      fireEvent.change(el("loop-replan"), { target: { value: "never" } });
    });
    expect(h.loop().budget.maxRounds).toBe(1);
    expect(el("loop-controls").textContent).toContain(
      "Re-plan never: one pass over the plan",
    );

    // Skip the waiting item: finished, shown cancelled, its question open
    await act(async () => {
      fireEvent.click(el("loop-skip-1"));
    });
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopDetail).toBe("All 2 items are done (1 skipped).");
    expect(h.store.getState().session.taskPlan!.items[0].status).toBe(
      "cancelled",
    );
    expect(h.loop().questions[0].answerId).toBeUndefined();

    // Run the done item again, then Resume
    await act(async () => {
      fireEvent.click(el("loop-again-2"));
    });
    expect(h.itemStatus("2")).toBe("pending");
    await act(async () => {
      fireEvent.click(el("loop-resume"));
    });
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    expect(h.prompt(3)).toContain("only this item: Write the lexer");
    expect(h.prompt(3)).toContain("the person asked for it to run again");
  });
});

async function pickMode(h: Awaited<ReturnType<typeof setup>>, testId: string) {
  // Each sent message keeps an editor with its own toolbar; the main
  // input's picker is the last one
  const buttons = document.querySelectorAll<HTMLElement>(
    "[data-testid=mode-select-button]",
  );
  await h.user.click(buttons[buttons.length - 1]);
  await h.user.click(await getElementByTestId(testId));
}

async function send(input: string) {
  const editor = await getMainEditor();
  await act(async () => {
    editor.commands.insertContent(input);
  });
  const submit = await getElementByTestId("submit-input-button");
  await act(async () => submit.click());
}

describe("Loop in the mode picker", () => {
  const modeButton = () =>
    document.querySelector("[data-testid=mode-select-button]")!.textContent;
  const presentPlan = calls({
    name: BuiltInToolNames.PresentPlan,
    args: {
      title: "Build the parser",
      plan: "Parse the grammar.",
      todos: ["Write the lexer", "Add tests"],
    },
  });

  test("choose Loop with Plan edits Permissive, and the presented plan starts the loop with no click", async () => {
    const h = await setup([]);
    // Plan edits Permissive: the first plan goes on without a click
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    h.turns.push(
      presentPlan,
      finish("done", "lexer written"),
      finish("done", "tests added"),
    );
    await pickMode(h, "mode-option-loop");
    expect(h.store.getState().session.mode).toBe("plan");
    expect(h.store.getState().session.loopRequested).toBe(true);

    await send("Plan the parser");

    // The first turn is an ordinary Plan turn: read-only, with present_plan
    await waitFor(() => expect(h.requests.length).toBeGreaterThan(0));
    expect(h.requests[0].tools).toContain(BuiltInToolNames.PresentPlan);
    expect(h.requests[0].tools).not.toContain(
      BuiltInToolNames.RunTerminalCommand,
    );
    expect(h.requests[0].tools).not.toContain(BuiltInToolNames.FinishItem);

    // The plan started the loop by itself, and its items ran
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(h.prompt(1)).toContain("only this item: Write the lexer");
    expect(h.prompt(2)).toContain("only this item: Add tests");
    expect(h.requests[1].tools).toContain(BuiltInToolNames.FinishItem);
    expect(h.requests).toHaveLength(3);
    // The card says the loop took it, instead of offering Build
    expect(
      document.querySelector("[data-testid=plan-card-build-loop]"),
    ).toBeNull();
    // Still in Loop: the next message plans again
    expect(h.store.getState().session.mode).toBe("plan");
    expect(modeButton()).toContain("Loop");
  });

  test.each(["cautious", "manual"] as const)(
    "at %s the first plan waits for you; Build in a loop starts it",
    async (level) => {
      const h = await setup([]);
      await act(async () => {
        h.store.dispatch(setPolicyLevel({ area: "plan", level }));
      });
      h.turns.push(
        presentPlan,
        finish("done", "lexer written"),
        finish("done", "tests added"),
      );
      await pickMode(h, "mode-option-loop");
      await send("Plan the parser");

      await waitFor(() =>
        expect(
          document.querySelector("[data-testid=plan-card-build-loop]"),
        ).not.toBeNull(),
      );
      // Nothing started: one request, no loop
      expect(h.requests).toHaveLength(1);
      expect(h.store.getState().session.loop).toBeUndefined();

      await act(async () => {
        fireEvent.click(
          document.querySelector("[data-testid=plan-card-build-loop]")!,
        );
      });
      await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    },
  );

  test("the picker shows Loop while the loop runs, and leaving it stops after the running item", async () => {
    const h = await setup([]);
    // Plan edits Permissive: the first plan goes on without a click
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.turns.push(
      presentPlan,
      // Item 1 is held while the person leaves Loop
      async function* () {
        yield [{ role: "assistant", content: "Working" }];
        await held;
        yield* finish("done", "lexer written")(new AbortController().signal);
      },
    );
    await pickMode(h, "mode-option-loop");
    await send("Plan the parser");

    await waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.loop().current?.itemId).toBe("1");
    expect(h.store.getState().session.mode).toBe("agent");
    expect(modeButton()).toContain("Loop");
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid=plan-card-loop-started]"),
      ).not.toBeNull(),
    );

    await pickMode(h, "mode-option-chat");
    // The item goes on in Agent mode; the picker shows the choice
    expect(h.loop().stopRequested).toBe(true);
    expect(h.loop().leaveRequested).toBe(true);
    expect(h.store.getState().session.mode).toBe("agent");
    expect(h.store.getState().session.loopRequested).toBeUndefined();
    expect(modeButton()).toContain("Chat");

    await act(async () => release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    // A pause, not an end: the loop says why and keeps its items
    expect(h.loop().stopReason).toBe("left_loop");
    expect(h.itemStatus("1")).toBe("done");
    expect(h.itemStatus("2")).toBe("pending");
    expect(h.requests).toHaveLength(2);
    expect(h.store.getState().session.mode).toBe("chat");
  });
});

describe("leaving Loop and coming back", () => {
  const presentPlan = calls({
    name: BuiltInToolNames.PresentPlan,
    args: {
      title: "Build the parser",
      plan: "Parse the grammar.",
      todos: ["Write the lexer", "Add tests"],
    },
  });
  const el = (id: string) =>
    document.querySelector<HTMLElement>(`[data-testid=${id}]`);

  /** Starts the loop, leaves Loop for Agent while item 1 runs, lets it finish. */
  async function pause(level: "permissive" | "cautious") {
    const h = await setup([]);
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.turns.push(presentPlan, async function* () {
      yield [{ role: "assistant", content: "Working" }];
      await held;
      yield* finish("done", "lexer written")(new AbortController().signal);
    });
    await pickMode(h, "mode-option-loop");
    await send("Plan the parser");
    await waitFor(() => expect(h.requests).toHaveLength(2));
    await pickMode(h, "mode-option-agent");
    await act(async () => release());
    await waitFor(() => expect(h.loop().stopReason).toBe("left_loop"));
    // The returning level is the one in force when Loop is chosen again
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level }));
    });
    return h;
  }

  test("the paused loop says so, and an Agent turn meanwhile is not a loop item", async () => {
    const h = await pause("permissive");
    expect(h.store.getState().session.mode).toBe("agent");
    expect(el("loop-paused")?.textContent).toContain(
      "Paused: you are in Agent mode",
    );
    expect(el("loop-phase")?.getAttribute("data-phase")).toBe("paused");

    const before = JSON.stringify(h.loop().items);
    h.turns.push(async function* () {
      yield [{ role: "assistant", content: "Fixed the typo" }];
    });
    const editor = await getMainEditor();
    await act(async () => {
      editor.commands.insertContent("Fix the typo in the readme");
    });
    // Earlier messages keep their own toolbars; the main input's is the last
    const submits = document.querySelectorAll<HTMLElement>(
      "[data-testid=submit-input-button]",
    );
    await act(async () => submits[submits.length - 1].click());
    await waitFor(() => expect(h.requests).toHaveLength(3));
    // An ordinary turn: the loop's items, budgets and status are untouched
    expect(h.requests[2].tools).not.toContain(BuiltInToolNames.FinishItem);
    expect(JSON.stringify(h.loop().items)).toBe(before);
    expect(h.loop().status).toBe("stopped");
    expect(h.loop().stopReason).toBe("left_loop");
  });

  test("back in Loop at Permissive it resumes by itself, telling the next item the workspace may have changed", async () => {
    const h = await pause("permissive");
    h.turns.push(finish("done", "tests added"));
    await pickMode(h, "mode-option-loop");
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    expect(h.itemStatus("2")).toBe("done");
    expect(h.prompt(2)).toContain("only this item: Add tests");
    expect(h.prompt(2)).toContain("paused while the person was outside Loop");
    // Said once
    expect(h.loop().workedOutside).toBeUndefined();
  });

  test("back in Loop at Cautious it asks: Resume loop (1 task left) goes on, Start fresh plans again", async () => {
    const h = await pause("cautious");
    await pickMode(h, "mode-option-loop");
    expect(h.loop().status).toBe("stopped");
    expect(el("loop-resume")?.textContent).toBe("Resume loop (1 task left)");
    expect(el("loop-paused")?.textContent).toContain("start fresh");

    h.turns.push(finish("done", "tests added"));
    await act(async () => {
      fireEvent.click(el("loop-resume")!);
    });
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    expect(h.prompt(2)).toContain("paused while the person was outside Loop");
  });

  test("Start fresh drops the paused loop", async () => {
    const h = await pause("cautious");
    await pickMode(h, "mode-option-loop");
    await act(async () => {
      fireEvent.click(el("loop-start-fresh")!);
    });
    expect(h.store.getState().session.loop).toBeUndefined();
    expect(h.store.getState().session.mode).toBe("plan");
    expect(h.store.getState().session.loopRequested).toBe(true);
  });

  test("a finished loop has nothing to resume: Loop plans again", async () => {
    const h = await setup([]);
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    h.turns.push(
      presentPlan,
      finish("done", "lexer written"),
      finish("done", "tests added"),
    );
    await pickMode(h, "mode-option-loop");
    await send("Plan the parser");
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));
    await pickMode(h, "mode-option-agent");
    expect(h.store.getState().session.mode).toBe("agent");
    await pickMode(h, "mode-option-loop");
    expect(h.loop().stopReason).toBe("done");
    expect(h.store.getState().session.mode).toBe("plan");
    expect(el("loop-resume")).toBeNull();
  });
});

describe("a to-do's own model", () => {
  const el = (id: string) =>
    document.querySelector<HTMLElement>(`[data-testid=${id}]`);
  const selectedTitle = (h: Awaited<ReturnType<typeof setup>>) =>
    h.store.getState().config.config.selectedModelByRole.chat?.title;

  test("runs on the model its plan file line names; the other items run on the loop model", async () => {
    const h = await setup([
      "Write the lexer",
      { text: "Design the grammar", model: "opus" },
      "Add tests",
    ]);
    let release = () => {};
    const held: Turn = async function* (signal) {
      yield [{ role: "assistant", content: "Thinking" }];
      await new Promise<void>((r) => (release = r));
      yield* finish("done", "designed")(signal);
    };
    h.turns.push(
      finish("done", "lexer written"),
      held,
      finish("done", "tested"),
    );
    await h.start();

    await waitFor(() => expect(h.requests).toHaveLength(2));
    // Item 2's request went to Opus (a family alias, resolved like a subagent's)
    expect(h.requests.map((r) => r.title)).toEqual(["Mock LLM", "Opus"]);
    expect(h.loop().items[1].model).toEqual({ title: "Opus" });
    expect(h.loop().modelBefore).toBe("Mock LLM");
    expect(el("loop-model-2")!.textContent).toBe("model: opus");
    expect(el("loop-model-1")).toBeNull();

    await act(async () => release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    // Item 3 came back to the model the loop started on, and so did the chat
    expect(h.requests.map((r) => r.title)).toEqual([
      "Mock LLM",
      "Opus",
      "Mock LLM",
    ]);
    expect(selectedTitle(h)).toBe("Mock LLM");
  });

  test("a model that is not configured falls back to the loop model, and the item says so", async () => {
    const h = await setup([{ text: "Design the grammar", model: "GPT-9" }]);
    let release = () => {};
    const held: Turn = async function* (signal) {
      yield [{ role: "assistant", content: "Thinking" }];
      await new Promise<void>((r) => (release = r));
      yield* finish("done", "designed")(signal);
    };
    h.turns.push(held);
    await h.start();

    await waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0].title).toBe("Mock LLM");
    expect(h.loop().items[0].model).toEqual({
      title: "Mock LLM",
      fallbackReason: 'model "GPT-9" is not configured; using Mock LLM',
    });
    expect(h.loop().modelBefore).toBeUndefined();
    expect(el("loop-model-fallback-1")!.textContent).toContain(
      "not configured, ran on Mock LLM",
    );
    // The task list carries the reason as the running item's note
    expect(h.store.getState().session.taskPlan!.items[0].note).toContain(
      "not configured",
    );

    await act(async () => release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
  });
});

describe("Loop mode's checks and dependencies", () => {
  type Setup = Awaited<ReturnType<typeof setup>>;
  const CHECK = "npm test -- retry";

  /** What the person's rules say about a terminal command. */
  function terminalPolicy(h: Setup, content: object) {
    h.ideMessenger.responseHandlers["tools/evaluatePolicy"] = async (
      data: any,
    ) =>
      data.toolName === BuiltInToolNames.RunTerminalCommand
        ? (content as any)
        : { policy: data.basePolicy };
  }
  const allowTerminal = (h: Setup) =>
    terminalPolicy(h, {
      policy: "allowedWithoutPermission",
      source: "allow-rule",
    });

  /** The IDE's subprocess: each call takes the next result; all are recorded. */
  function subprocess(h: Setup, ...results: (string | Error)[]) {
    const ran: { command: string; cwd?: string; requests: number }[] = [];
    h.ideMessenger.responseHandlers["subprocess"] = async (data: any) => {
      ran.push({ ...data, requests: h.requests.length });
      const result = results.shift() ?? "ok";
      if (result instanceof Error) throw result;
      return [result, ""];
    };
    return ran;
  }

  const presentPlan = (todos: string[], todo_details: object[]) =>
    calls({
      name: BuiltInToolNames.PresentPlan,
      args: { title: "Add retries", plan: "Retry fetch.", todos, todo_details },
    });

  /** A turn that waits for release() before it reports done. */
  function heldFinish(summary: string) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const turn: Turn = async function* (signal) {
      yield [{ role: "assistant", content: "Working" }];
      await held;
      yield* finish("done", summary)(signal);
    };
    return { turn, release: () => release() };
  }

  const el = (id: string) =>
    document.querySelector<HTMLElement>(`[data-testid=${id}]`);

  async function startInLoop(h: Setup) {
    // The first plan goes on by itself at Plan edits Permissive
    await act(async () => {
      h.store.dispatch(setPolicyLevel({ area: "plan", level: "permissive" }));
    });
    await pickMode(h, "mode-option-loop");
    await send("Plan the retries");
  }

  test("an item's check runs when it reports done; passing, the item is done and the next runs", async () => {
    const h = await setup([]);
    allowTerminal(h);
    const ran = subprocess(h, "Tests: 3 passed");
    h.turns.push(
      presentPlan(
        ["Add a retry helper", "Document it"],
        [{ todo: 1, check: CHECK }],
      ),
      finish("done", "helper added"),
      finish("done", "documented"),
    );
    await startInLoop(h);

    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    // The check ran in the workspace after item 1, before item 2's turn
    expect(ran).toEqual([
      { command: CHECK, cwd: "/Users/user/workspace1", requests: 2 },
    ]);
    expect(h.prompt(1)).toContain(
      `When you report it done, its check runs: \`${CHECK}\``,
    );
    expect(h.prompt(2)).toContain("only this item: Document it");
    expect(h.requests).toHaveLength(3);
    expect(h.loop().items[0]).toMatchObject({
      status: "done",
      check: { status: "passed", command: CHECK, output: "Tests: 3 passed" },
    });
    expect(el("loop-check-result-1")!.textContent).toContain("check passed");
    expect(el("loop-check-2")).toBeNull();
  });

  test("a loop's fallback check holds an item with no check of its own, and an item's own check wins", async () => {
    const h = await setup([
      "Add a retry helper",
      { text: "Document it", check: "npm run docs:check" },
    ]);
    allowTerminal(h);
    const ran = subprocess(h, "Tests: 3 passed", "docs ok");
    h.turns.push(finish("done", "helper added"), finish("done", "documented"));
    await h.start({ fallbackCheck: "npm test" });

    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(h.loop().fallbackCheck).toBe("npm test");
    expect(ran.map((r) => r.command)).toEqual([
      "npm test",
      "npm run docs:check",
    ]);
    expect(h.prompt(0)).toContain("its check runs: `npm test`");
    expect(h.loop().items[0]).toMatchObject({
      status: "done",
      check: { status: "passed", command: "npm test" },
    });
  });

  test("without a fallback check an item with none is done on its own report", async () => {
    const h = await setup(["Add a retry helper"]);
    const ran = subprocess(h);
    h.turns.push(finish("done", "helper added"));
    await h.start();
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(ran).toHaveLength(0);
    expect(h.loop().items[0].check).toBeUndefined();
  });

  test("a failing check sends the item back with the failure in its prompt", async () => {
    const h = await setup([]);
    allowTerminal(h);
    const ran = subprocess(h, new Error("1 test failed"), "all passed");
    const again = heldFinish("retries fixed");
    h.turns.push(
      presentPlan(["Add a retry helper"], [{ todo: 1, check: CHECK }]),
      finish("done", "helper added"),
      again.turn,
    );
    await startInLoop(h);

    // The second run: its prompt has the check's output
    await waitFor(() => expect(h.requests).toHaveLength(3));
    expect(h.prompt(2)).toContain("only this item: Add a retry helper");
    expect(h.prompt(2)).toContain(`but its check \`${CHECK}\` failed.`);
    expect(h.prompt(2)).toContain("1 test failed");
    expect(h.loop().items[0].check).toMatchObject({
      status: "failed",
      exitCode: null,
      output: "1 test failed",
    });
    // The inbox shows the failure while the item runs again
    expect(el("loop-check-result-1")!.textContent).toContain("check failed");
    expect(el("loop-check-output-1")!.textContent).toBe("1 test failed");

    await act(async () => again.release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(ran).toHaveLength(2);
    expect(h.itemStatus("1")).toBe("done");
  });

  test("a to-do that comes after another runs only once that one is done", async () => {
    const h = await setup([]);
    const first = heldFinish("helper added");
    h.turns.push(
      presentPlan(
        ["Use it in fetch", "Add a retry helper"],
        [{ todo: 1, after: [2] }],
      ),
      first.turn,
      finish("done", "fetch retries"),
    );
    await startInLoop(h);

    await waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.prompt(1)).toContain("only this item: Add a retry helper");
    expect(h.itemStatus("1")).toBe("pending");
    expect(el("loop-after-1")!.textContent).toBe("after 2");

    await act(async () => first.release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(h.prompt(2)).toContain("only this item: Use it in fetch");
    expect(el("loop-after-1")).toBeNull();
  });

  test("a check that would ask is held as an approval question, and Allow runs it", async () => {
    // The harness's Manual mode: run_terminal_command asks
    const h = await setup([]);
    const ran = subprocess(h, "ok");
    h.turns.push(
      presentPlan(["Add a retry helper"], [{ todo: 1, check: CHECK }]),
      finish("done", "helper added"),
    );
    await startInLoop(h);

    await waitFor(() => expect(h.loop().status).toBe("waiting"));
    expect(ran).toEqual([]);
    expect(h.itemStatus("1")).toBe("checking");
    expect(h.loop().current).toBeUndefined();
    expect(h.loop().questions[0]).toMatchObject({
      itemId: "1",
      kind: "approval",
      question: `Allow this call? ${CHECK}`,
    });
    expect(el("loop-item-1")!.textContent).toContain("check waits");

    await act(async () => {
      fireEvent.click(el("loop-approve")!);
    });
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    expect(ran).toHaveLength(1);
    expect(h.itemStatus("1")).toBe("done");
    expect(h.loop().items[0].check?.status).toBe("passed");
    expect(h.loop().grants).toEqual([]);
    expect(h.requests).toHaveLength(2);
  });

  test("a check a rule refuses is not run, and the item is not done", async () => {
    const h = await setup([]);
    terminalPolicy(h, {
      policy: "disabled",
      source: "deny-rule",
      reason: "Blocked by your rule run_terminal_command(npm test*)",
    });
    const ran = subprocess(h, "ok");
    const reply = (content: string): Turn =>
      async function* () {
        yield [{ role: "assistant", content }];
      };
    // The refusal fails the item. The repair re-plan that follows gets two
    // replies and no new plan, so the loop stops. The item is not done.
    h.turns.push(
      presentPlan(["Add a retry helper"], [{ todo: 1, check: CHECK }]),
      finish("done", "helper added"),
      reply("Looking"),
      reply("Still looking"),
    );
    await startInLoop(h);

    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).not.toBe("done");
    expect(ran).toEqual([]);
    expect(h.itemStatus("1")).toBe("failed");
    expect(h.loop().items[0].summary).toContain("check not run");
    expect(h.loop().items[0].check).toMatchObject({
      status: "refused",
      output: "Blocked by your rule run_terminal_command(npm test*)",
    });
    expect(el("loop-check-result-1")!.textContent).toContain(
      "check not run: Blocked by your rule",
    );
  });

  test("a reminder reaches the next item once, marked when its file changed", async () => {
    const h = await setup(["Write the lexer", "Add tests"]);
    const file = "file:///Users/user/workspace1/a.ts";
    h.files[file] = "before";
    h.ideMessenger.responseHandlers["tools/call"] = async () => {
      h.files[file] = "after";
      return {
        contextItems: [{ name: "a.ts", description: "a.ts", content: "src" }],
      };
    };
    h.turns.push(
      calls({
        name: BuiltInToolNames.RemindMe,
        args: {
          note: "a.ts has the grammar",
          when: "next_items",
          files: ["a.ts"],
        },
      }),
      calls({ name: BuiltInToolNames.ReadFile, args: { filepath: "a.ts" } }),
      finish("done", "lexer written"),
      finish("done", "tests added"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));

    expect(h.requests[0].tools).toContain(BuiltInToolNames.RemindMe);
    expect(h.prompt(0)).toContain("save it with remind_me now");
    expect(h.prompt(0)).not.toContain("a.ts has the grammar");
    expect(h.prompt(3)).toContain("only this item: Add tests");
    expect(h.prompt(3)).toContain(
      "- (from item 1; written before these files changed, so check first: a.ts) a.ts has the grammar",
    );
    expect(h.loop().reminders?.[0].deliveredAt).toBeDefined();
  });

  test('an item set aside with "later" comes back last, with its note', async () => {
    const h = await setup(["Write the lexer", "Add tests"]);
    h.turns.push(
      calls({
        name: BuiltInToolNames.FinishItem,
        args: {
          outcome: "later",
          summary: "Needs the tests first",
          reminder: "Tried a table; the tests fix the grammar",
        },
      }),
      finish("done", "tests added"),
      finish("done", "lexer written"),
    );
    await h.start();
    await waitFor(() => expect(h.loop().stopReason).toBe("done"));

    expect(h.prompt(1)).toContain("only this item: Add tests");
    expect(h.prompt(2)).toContain("only this item: Write the lexer");
    expect(h.prompt(2)).toContain("set this item aside");
    expect(h.prompt(2)).toContain("Tried a table; the tests fix the grammar");
    expect(h.loop().items[0].deferrals).toBe(1);
    expect(h.loop().consecutiveFailures ?? 0).toBe(0);
  });
});

describe("Loop mode's parallel waves", () => {
  type Setup = Awaited<ReturnType<typeof setup>>;
  const el = (id: string) =>
    document.querySelector<HTMLElement>(`[data-testid=${id}]`);

  /**
   * Fake worktrees (the seam for core/util/worktree.ts): every call is
   * recorded; `refuse` says which patches do not apply, and why.
   */
  function fakeWorktrees(
    refuse: (patch: string) => string | undefined = () => undefined,
  ) {
    const calls: string[] = [];
    const ops: LoopWorktreeOps = {
      async create(_messenger, repo, slug, itemId) {
        calls.push(`create ${slug}-${itemId} in ${repo}`);
        const path = `/tmp/loop/item-${itemId}-x`;
        return {
          path,
          branch: `continued/loop-${slug}-${itemId}`,
          baseline: "b",
        };
      },
      async patch(_messenger, worktree) {
        calls.push(`patch ${worktree.path}`);
        return `patch of ${worktree.path}`;
      },
      async apply(_messenger, _repo, patch, touchedSince) {
        calls.push(
          `apply ${patch}${touchedSince.length ? ` (touched: ${touchedSince.join(", ")})` : ""}`,
        );
        const reason = refuse(patch);
        return reason ? { ok: false, reason } : { ok: true };
      },
      async remove(_messenger, _repo, worktree) {
        calls.push(`remove ${worktree.path}`);
      },
      async dirty() {
        return [];
      },
    };
    setLoopWorktreeOps(ops);
    return calls;
  }
  afterEach(() => setLoopWorktreeOps());

  /** A worker's turn that waits for release() before it reports done. */
  function heldFinish(summary: string) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const turn: Turn = async function* (signal) {
      yield [{ role: "assistant", content: "Working" }];
      await held;
      yield* finish("done", summary)(signal);
    };
    return { turn, release: () => release() };
  }

  /** A turn that writes a line, then waits until its run is stopped. */
  const untilStopped: Turn = async function* (signal) {
    yield [{ role: "assistant", content: "Working" }];
    await new Promise<void>((r) =>
      signal.aborted
        ? r()
        : signal.addEventListener("abort", () => r(), { once: true }),
    );
  };

  /** The plan block of request n (a worker's goes in its first message). */
  const block = (h: Setup, n: number) =>
    text(h.requests[n].messages.find((m) => m.role === "user")).split(
      "<task_list>",
    )[1] ?? "";

  test("two items with disjoint files run as two workers at once, merge in finish order, and the third runs inline after", async () => {
    const h = await setup([
      { text: "Add the retry helper", files: ["src/retry.ts"] },
      {
        text: "Document the config",
        files: ["docs/config.md"],
        check: "npm run docs:check",
      },
      "Wire it up",
    ]);
    const calls = fakeWorktrees();
    // The check may run: the person's rules allow the terminal
    h.ideMessenger.responseHandlers["tools/evaluatePolicy"] = async (
      data: any,
    ) =>
      data.toolName === BuiltInToolNames.RunTerminalCommand
        ? ({ policy: "allowedWithoutPermission", source: "allow-rule" } as any)
        : { policy: data.basePolicy };
    const checks: { command: string; cwd?: string }[] = [];
    h.ideMessenger.responseHandlers["subprocess"] = async (data: any) => {
      checks.push(data);
      return ["docs ok", ""];
    };
    const first = heldFinish("retry added");
    const second = heldFinish("documented");
    h.turns.push(first.turn, second.turn, finish("done", "wired"));
    await h.start({ parallel: true });

    // Two requests in flight, one per worker, each in its own worktree
    await waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.loop().parallel?.map((r) => r.itemId)).toEqual(["1", "2"]);
    expect(h.loop().current).toBeUndefined();
    expect(h.itemStatus("1")).toBe("running");
    expect(h.itemStatus("2")).toBe("running");
    expect(h.itemStatus("3")).toBe("pending");
    expect(calls).toEqual([
      "create build-the-parser-1 in /Users/user/workspace1",
      "create build-the-parser-2 in /Users/user/workspace1",
    ]);
    // Each worker's prompt is for its item, in its worktree, with its files
    expect(h.prompt(0)).toContain("only this item: Add the retry helper");
    expect(h.prompt(0)).toContain("/tmp/loop/item-1-");
    expect(h.prompt(0)).toContain("src/retry.ts");
    expect(h.prompt(1)).toContain("only this item: Document the config");
    expect(h.prompt(1)).toContain("/tmp/loop/item-2-");
    // ... and its plan block marks its own item, with the other running
    expect(block(h, 0)).toMatch(/1\. Add the retry helper  <- this item/);
    expect(block(h, 0)).toMatch(
      /2\. Document the config \(running now, in its own copy/,
    );
    expect(block(h, 1)).toMatch(/2\. Document the config  <- this item/);
    expect(block(h, 1)).toMatch(/1\. Add the retry helper \(running now/);
    // The worker's own system message, with its tools: the loop's three and
    // the exact edit, which runs in its worktree without a diff review
    const system = text(h.requests[0].messages[0]);
    expect(system).toContain("You are a worker of a Loop plan");
    // The same for every worker, so the wave shares one cached prefix; the
    // worktree and the files are in each item's prompt instead
    expect(text(h.requests[1].messages[0])).toBe(system);
    expect(system).not.toContain("/tmp/loop/");
    for (const name of [
      BuiltInToolNames.FinishItem,
      BuiltInToolNames.HoldQuestion,
      BuiltInToolNames.RemindMe,
      BuiltInToolNames.SingleFindAndReplace,
      BuiltInToolNames.CreateNewFile,
    ]) {
      expect(system).toContain(name);
    }
    expect(system).not.toContain(BuiltInToolNames.TaskList);
    // The inbox shows the workers, their worktrees and model, and the files
    expect(el("loop-item-1")!.textContent).toContain("running in parallel");
    expect(el("loop-worker-1")!.textContent).toContain("/tmp/loop/item-1-");
    expect(el("loop-worker-1")!.textContent).toContain("Mock LLM");
    expect(el("loop-files-1")!.textContent).toContain("src/retry.ts");
    expect(el("loop-files-3")).toBeNull();
    expect(
      h.store.getState().session.taskPlan!.items.map((i) => i.note),
    ).toEqual([
      "Running in its own worktree, beside other items",
      "Running in its own worktree, beside other items",
      undefined,
    ]);

    // Item 2 finishes first: its patch is merged first and its check runs in
    // the checkout while item 1 still runs; no item starts meanwhile
    await act(async () => second.release());
    await waitFor(() => expect(h.itemStatus("2")).toBe("done"));
    expect(checks).toEqual([
      { command: "npm run docs:check", cwd: "/Users/user/workspace1" },
    ]);
    expect(h.loop().items[1].check).toMatchObject({
      status: "passed",
      output: "docs ok",
    });
    expect(h.itemStatus("1")).toBe("running");
    expect(h.loop().parallel?.map((r) => r.itemId)).toEqual(["1"]);
    expect(h.requests).toHaveLength(2);
    expect(el("loop-worker-2")).toBeNull();

    await act(async () => first.release());
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    // The third item, with no files, ran inline after the wave
    expect(h.requests).toHaveLength(3);
    expect(h.prompt(2)).toContain("only this item: Wire it up");
    expect(h.prompt(2)).not.toContain("This item runs in its own copy");
    expect(h.loop().items.map((i) => i.summary)).toEqual([
      "retry added",
      "documented",
      "wired",
    ]);
    // Merged in finish order, each worktree removed once its patch is in
    expect(calls.slice(2)).toEqual([
      expect.stringMatching(/^patch \/tmp\/loop\/item-2-/),
      expect.stringMatching(/^apply patch of \/tmp\/loop\/item-2-/),
      expect.stringMatching(/^remove \/tmp\/loop\/item-2-/),
      expect.stringMatching(/^patch \/tmp\/loop\/item-1-/),
      expect.stringMatching(/^apply patch of \/tmp\/loop\/item-1-/),
      expect.stringMatching(/^remove \/tmp\/loop\/item-1-/),
    ]);
  });

  test("a refused patch sends the item back inline, with the reason in its prompt", async () => {
    const h = await setup([
      { text: "Add the retry helper", files: ["src/retry.ts"] },
      { text: "Document the config", files: ["docs/config.md"] },
    ]);
    const calls = fakeWorktrees((patch) =>
      patch.includes("item-1-")
        ? "error: patch failed: src/retry.ts:3\nerror: src/retry.ts: patch does not apply"
        : undefined,
    );
    h.turns.push(
      finish("done", "retry added"),
      finish("done", "documented"),
      finish("done", "retry added inline"),
    );
    await h.start({ parallel: true });

    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("done");
    // Item 1's report did not count: it ran again, inline, on the merged tree
    expect(h.requests).toHaveLength(3);
    expect(h.prompt(2)).toContain("only this item: Add the retry helper");
    expect(h.prompt(2)).toContain("could not be merged");
    expect(h.prompt(2)).toContain("src/retry.ts:3");
    expect(h.prompt(2)).not.toContain("This item runs in its own copy");
    expect(h.loop().items[0]).toMatchObject({
      status: "done",
      attempts: 2,
      summary: "retry added inline",
    });
    expect(h.loop().items[1]).toMatchObject({ status: "done", attempts: 1 });
    // Both worktrees went, the refused one too
    expect(calls.filter((c) => c.startsWith("remove"))).toHaveLength(2);
  });

  test("a session switch ends the workers; their worktrees go and the loop they belonged to is not touched", async () => {
    const h = await setup([
      { text: "Add the retry helper", files: ["src/retry.ts"] },
      { text: "Document the config", files: ["docs/config.md"] },
    ]);
    const calls = fakeWorktrees();
    h.turns.push(untilStopped, untilStopped);
    await h.start({ parallel: true });
    await waitFor(() => expect(h.requests).toHaveLength(2));

    const { newSession } = await import("../../../redux/slices/sessionSlice");
    await act(async () => {
      h.store.dispatch(newSession());
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.startsWith("remove"))).toHaveLength(2),
    );
    expect(calls.some((c) => c.startsWith("apply"))).toBe(false);
    expect(h.store.getState().session.loop).toBeUndefined();
    expect(h.requests).toHaveLength(2);
  });

  test("Stop ends the wave's workers at once: their items go back to pending and the worktrees go", async () => {
    const h = await setup([
      { text: "Add the retry helper", files: ["src/retry.ts"] },
      { text: "Document the config", files: ["docs/config.md"] },
    ]);
    const calls = fakeWorktrees();
    h.turns.push(untilStopped, untilStopped);
    await h.start({ parallel: true });
    await waitFor(() => expect(h.requests).toHaveLength(2));

    expect(el("loop-stop")!.getAttribute("aria-label")).toBe("Stop the wave");
    expect(el("loop-stop-now")).toBeNull();
    await act(async () => {
      fireEvent.click(el("loop-stop")!);
    });
    await waitFor(() => expect(h.loop().status).toBe("stopped"));
    expect(h.loop().stopReason).toBe("stopped");
    expect(h.loop().parallel).toBeUndefined();
    expect(h.itemStatus("1")).toBe("pending");
    expect(h.itemStatus("2")).toBe("pending");
    // A stopped worker's changes are dropped with its worktree
    await waitFor(() =>
      expect(calls.filter((c) => c.startsWith("remove"))).toHaveLength(2),
    );
    expect(calls.some((c) => c.startsWith("apply"))).toBe(false);
    expect(h.requests).toHaveLength(2);
  });
});
