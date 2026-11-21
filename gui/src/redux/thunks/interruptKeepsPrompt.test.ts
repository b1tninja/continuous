import type { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../slices/sessionSlice";
import { setupStore } from "../store";
import { cancelStream, interruptStream } from "./cancelStream";

/**
 * The thunks that end a turn, through the real store: "Steer now" ends the
 * reply where it is and the person's next message goes after it; Stop ends it
 * and marks it for Resume. Neither may lose the message that was in flight.
 */
const item = (
  role: string,
  content: string,
  extra: Record<string, unknown> = {},
): ChatHistoryItem =>
  ({ message: { role, content }, contextItems: [], ...extra }) as never;

function streamingStore(history: ChatHistoryItem[]) {
  const store = setupStore({ ideMessenger: new MockIdeMessenger() });
  store.dispatch(
    newSession({
      sessionId: "s1",
      title: "t",
      workspaceDirectory: "",
      history: history.map((h, i) => ({
        ...h,
        message: { ...h.message, id: `m${i}` },
      })),
    } as never),
  );
  return store;
}

const inFlight = () => [
  item("assistant", "Done with the last task."),
  item("user", "check our own usage and session history", {
    editorState: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "check our own usage" }],
        },
      ],
    },
  }),
  item("assistant", ""),
  item("thinking", "This new request shifts dire", {
    reasoning: {
      active: true,
      text: "This new request shifts dire",
      startAt: 1,
    },
  }),
];

const userTexts = (store: ReturnType<typeof streamingStore>) =>
  store
    .getState()
    .session.history.filter((h) => h.message.role === "user")
    .map((h) => String(h.message.content));

describe("ending a turn that is only thinking, through the store", () => {
  it("Steer now keeps the message the person sent", async () => {
    const store = streamingStore(inFlight());
    await store.dispatch(interruptStream());
    expect(userTexts(store)).toEqual([
      "check our own usage and session history",
    ]);
  });

  it("Steer now keeps the partial thought and does not refill the input box", async () => {
    const store = streamingStore(inFlight());
    // Loading a session marks a turn that was still reasoning as cut off by a
    // reload; that is not the steer's doing, so compare with what it was.
    const marked = store.getState().session.history[3].interrupted;
    await store.dispatch(interruptStream());
    const s = store.getState().session;
    expect(s.history.map((h) => h.message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "thinking",
    ]);
    expect(s.mainEditorContentTrigger).toBeUndefined();
    // the steer adds no mark of its own ("stopped" is for Stop)
    expect(s.history[3].interrupted).toBe(marked);
    expect(s.history[3].interrupted).not.toBe("stopped");
  });

  it("the next message goes after the kept one: nothing is overwritten", async () => {
    const store = streamingStore(inFlight());
    await store.dispatch(interruptStream());
    const before = store.getState().session.history.length;
    // what sending the next message does: append
    expect(before).toBe(4);
    expect(userTexts(store)).toContain(
      "check our own usage and session history",
    );
  });

  it("Stop keeps the message and marks the thought for Resume", async () => {
    const store = streamingStore(inFlight());
    await store.dispatch(cancelStream(undefined));
    const s = store.getState().session;
    expect(userTexts(store)).toHaveLength(1);
    expect(s.history[3].interrupted).toBe("stopped");
  });

  it("a retry still drops the message so it is sent again", async () => {
    const store = streamingStore(inFlight().slice(1));
    await store.dispatch(cancelStream({ loop: "keep" }));
    expect(store.getState().session.history).toEqual([]);
  });

  it("Steer now before the model wrote anything keeps the message", async () => {
    const store = streamingStore(inFlight().slice(0, 3));
    await store.dispatch(interruptStream());
    expect(userTexts(store)).toHaveLength(1);
    expect(store.getState().session.mainEditorContentTrigger).toBeUndefined();
  });
});
