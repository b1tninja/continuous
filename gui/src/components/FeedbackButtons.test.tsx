import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatHistoryItem, PromptLog } from "core";
import { sha256Hex } from "core/util/secretScan/sha256";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { IdeMessengerProvider } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import sessionReducer, {
  addPromptCompletionPair,
} from "../redux/slices/sessionSlice";
import { createMockStore, getEmptyRootState } from "../util/test/mockStore";
import { FeedbackButtons } from "./FeedbackButtons";

/* PERF10: feedback sends only the newest request's prompt; every older
   request sends its size and SHA-256 in place of the text. */

const log = (n: number): PromptLog => ({
  modelTitle: "m",
  modelProvider: "p",
  prompt: `full prompt ${n}`,
  completion: `completion ${n}`,
});

const assistant = (id: string): ChatHistoryItem =>
  ({
    message: { role: "assistant", content: "a", id },
    contextItems: [],
  }) as ChatHistoryItem;

async function feedbackFor(item: ChatHistoryItem) {
  const messenger = new MockIdeMessenger();
  const post = vi.spyOn(messenger, "post");
  const store = createMockStore(undefined, messenger);
  const { getAllByRole } = render(
    <IdeMessengerProvider messenger={messenger}>
      <Provider store={store}>
        <FeedbackButtons item={item} />
      </Provider>
    </IdeMessengerProvider>,
  );
  await userEvent.click(getAllByRole("button")[1]);
  return post.mock.calls
    .filter(
      ([type, data]) =>
        type === "devdata/log" && (data as any).name === "chatFeedback",
    )
    .map(([, data]) => (data as any).data);
}

const notSent = (prompt: string) =>
  `[prompt not sent: older request, ${new TextEncoder().encode(prompt).length} bytes, sha256 ${sha256Hex(prompt)}]`;

describe("FeedbackButtons (PERF10)", () => {
  it("sends one full prompt and the size and hash of every other request", async () => {
    // two requests answered by one item (a tool call and its follow-up), then
    // a third in a second call: only the third keeps its prompt in memory
    let state = {
      ...getEmptyRootState().session,
      history: [assistant("a1")] as any,
    };
    state = sessionReducer(state, addPromptCompletionPair([log(1), log(2)]));
    state = sessionReducer(state, addPromptCompletionPair([log(3)]));

    const sent = await feedbackFor(state.history[0]);
    expect(sent.map((d) => d.prompt)).toEqual([
      notSent("full prompt 1"),
      notSent("full prompt 2"),
      "full prompt 3",
    ]);
    expect(sent.map((d) => d.completion)).toEqual([
      "completion 1",
      "completion 2",
      "completion 3",
    ]);
    expect(sent.every((d) => d.feedback === false)).toBe(true);
    expect(sent[0]).not.toHaveProperty("promptSha256");
  });

  it("sends no full prompt for an older item", async () => {
    let state = {
      ...getEmptyRootState().session,
      history: [assistant("a1")] as any,
    };
    state = sessionReducer(state, addPromptCompletionPair([log(1)]));
    state = {
      ...state,
      history: [...state.history, assistant("a2")] as any,
    };
    state = sessionReducer(state, addPromptCompletionPair([log(2)]));

    const older = await feedbackFor(state.history[0]);
    expect(older.map((d) => d.prompt)).toEqual([notSent("full prompt 1")]);
  });
});
