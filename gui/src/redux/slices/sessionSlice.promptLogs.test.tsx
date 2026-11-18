import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PromptLog, Session } from "core";
import { DROPPED_PROMPT_MARKER } from "core/util/promptLogs";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { FeedbackButtons } from "../../components/FeedbackButtons";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { saveCurrentSession } from "../thunks/session";
import sessionReducer, {
  addPromptCompletionPair,
  newSession,
  type ChatHistoryItemWithMessageId,
} from "./sessionSlice";

/* Prompt logs: only the newest request keeps its full prompt in memory, and
   none is saved, so a session grows with its length, not its square. */

const log = (n: number, prompt = `full prompt ${n}`): PromptLog => ({
  modelTitle: "m",
  modelProvider: "p",
  prompt,
  completion: `completion ${n}`,
});

let ids = 0;
const item = (
  role: "user" | "assistant",
  content = "x",
  promptLogs?: PromptLog[],
): ChatHistoryItemWithMessageId => ({
  message: { role, content, id: `m${++ids}` },
  contextItems: [],
  ...(promptLogs && { promptLogs }),
});

const empty = () => getEmptyRootState().session;

/** Runs `turns` request/response pairs through the reducer, each request's
 *  prompt being the whole conversation before it, as a real prompt is. */
function runTurns(turns: number) {
  const turnText = "word ".repeat(100);
  const conversation = turnText.repeat(turns * 2);
  let state = empty();
  for (let t = 0; t < turns; t++) {
    state = {
      ...state,
      history: [
        ...state.history,
        item("user", turnText),
        item("assistant", turnText),
      ],
    };
    const prompt = conversation.slice(0, (2 * t + 1) * turnText.length);
    state = sessionReducer(state, addPromptCompletionPair([log(t, prompt)]));
  }
  return state;
}

describe("addPromptCompletionPair", () => {
  it("keeps the full prompt only on the newest request", () => {
    const state = runTurns(3);
    const prompts = state.history.flatMap(
      (h) => h.promptLogs?.map((l) => l.prompt) ?? [],
    );
    expect(prompts.slice(0, 2)).toEqual([
      DROPPED_PROMPT_MARKER,
      DROPPED_PROMPT_MARKER,
    ]);
    expect(prompts[2]).toMatch(/^word /);
    // completions of older requests stay
    expect(state.history[1].promptLogs?.[0].completion).toBe("completion 0");
  });

  it("keeps an item that is already small the same object", () => {
    const before = runTurns(3);
    const after = sessionReducer(
      {
        ...before,
        history: [...before.history, item("assistant")],
      },
      addPromptCompletionPair([log(9)]),
    );
    expect(after.history[1]).toBe(before.history[1]);
    expect(after.history[5]).not.toBe(before.history[5]);
  });

  it("a 200 turn session stays linear in size", () => {
    const at100 = JSON.stringify(runTurns(100).history).length;
    const at200 = JSON.stringify(runTurns(200).history).length;
    // Twice the turns, about twice the size; with every prompt kept the 200
    // turn history is ~20 MB and ~3.5x the 100 turn one.
    expect(at200 / at100).toBeLessThan(2.2);
    expect(at200).toBeLessThan(1_000_000);
  });
});

describe("newSession", () => {
  it("drops the prompts of older requests in a loaded session", () => {
    const loaded: Session = {
      sessionId: "s1",
      title: "Old",
      workspaceDirectory: "",
      history: [
        item("assistant", "a", [log(1, "p".repeat(1_000_000))]),
        item("assistant", "b", [log(2)]),
      ],
    };
    const state = sessionReducer(empty(), newSession(loaded));
    expect(state.history[0].promptLogs?.[0].prompt).toBe(DROPPED_PROMPT_MARKER);
    expect(state.history[1].promptLogs?.[0].prompt).toBe("full prompt 2");
  });
});

describe("saveCurrentSession", () => {
  it("sends no prompt to the extension", async () => {
    const messenger = new MockIdeMessenger();
    const request = vi.spyOn(messenger, "request");
    const store = createMockStore(
      {
        session: {
          ...empty(),
          title: "Kept",
          history: [item("user", "q"), item("assistant", "a", [log(1)])],
        },
      },
      messenger,
    );
    await store.dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }) as any,
    );
    const save = request.mock.calls.find(([type]) => type === "history/save");
    expect(save).toBeDefined();
    const saved = save![1] as Session;
    expect(saved.history[1].promptLogs?.[0]).toMatchObject({
      prompt: DROPPED_PROMPT_MARKER,
      completion: "completion 1",
    });
    // memory still has the newest prompt for the feedback buttons
    expect(
      (store.getState() as any).session.history[1].promptLogs?.[0].prompt,
    ).toBe("full prompt 1");
  });
});

describe("FeedbackButtons", () => {
  it("sends the newest request's full prompt with the feedback", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    const store = createMockStore(undefined, messenger);
    const { getAllByRole } = render(
      <IdeMessengerProvider messenger={messenger}>
        <Provider store={store}>
          <FeedbackButtons item={item("assistant", "a", [log(7)])} />
        </Provider>
      </IdeMessengerProvider>,
    );
    const buttons = getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(buttons[0]);
    const feedback = post.mock.calls.find(
      ([type, data]) =>
        type === "devdata/log" && (data as any).name === "chatFeedback",
    );
    expect(feedback?.[1]).toMatchObject({
      data: { prompt: "full prompt 7", completion: "completion 7" },
    });
  });
});
