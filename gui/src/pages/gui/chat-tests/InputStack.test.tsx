import { act } from "@testing-library/react";
import { newSession, setTaskPlan } from "../../../redux/slices/sessionSlice";
import { renderWithProviders } from "../../../util/test/render";
import { getElementByTestId } from "../../../util/test/utils";
import { Chat } from "../Chat";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const SESSION = {
  sessionId: "stack",
  title: "Stack",
  workspaceDirectory: "",
  history: [
    { message: { role: "user", content: "Hello" }, contextItems: [] },
    { message: { role: "assistant", content: "Hi" }, contextItems: [] },
  ],
  queuedMessages: [{ id: "q1", editorState: doc("later"), modifiers: {} }],
};

const PLAN = {
  items: [{ id: "1", text: "One", status: "pending" }],
  updatedAt: "2026-11-21T00:00:00Z",
};

vi.setConfig({ testTimeout: 15000 });

beforeEach(() => {
  // Focusing the editor scrolls the selection into view; jsdom has no scrollBy.
  window.scrollBy = vi.fn();
});

// jsdom does not lay out: this pins which part of the stack above the prompt
// gives way and scrolls. The heights are measured by bench/screenshots.
describe("The stack above the prompt", () => {
  test("the task list and the queue give way; the prompt does not", async () => {
    const { store } = await renderWithProviders(<Chat />);
    await act(async () => {
      store.dispatch(newSession(SESSION as never));
      store.dispatch(setTaskPlan(PLAN as never));
    });

    const notices = await getElementByTestId("input-stack-notices");
    const queue = await getElementByTestId("input-stack-queue");
    expect(notices).toContainElement(
      await getElementByTestId("task-list-panel"),
    );
    expect(queue).toContainElement(await getElementByTestId("queued-messages"));
    const prompt = await getElementByTestId("editor-input-main");
    for (const part of [notices, queue]) {
      expect(part.className).toContain("overflow-y-auto");
      // It starts from one row and grows to its content, no further, long
      // before the chat grows; both are laid out by the page: the stack's own
      // box is gone ("contents")
      expect(part.className).toContain("basis-[22px]");
      expect(part.className).toContain("grow-[9999]");
      expect(part.className).toContain("max-h-max");
      expect(part.parentElement!.className).toBe("contents");
      expect(part).not.toContainElement(prompt);
    }
    // Under one row each, the queue gives way before the notices, and both
    // long before the chat
    expect(notices.className).toContain("shrink-[9999]");
    expect(queue.className).toContain("shrink-[9999999]");
    const chat = document.querySelector('[aria-label="Conversation"]')!;
    expect(chat.className).toContain("flex-[1_1_96px]");
  });

  test("an empty chat is laid out as before: nothing gives way", async () => {
    await renderWithProviders(<Chat />);
    for (const id of ["input-stack-notices", "input-stack-queue"]) {
      const part = await getElementByTestId(id);
      expect(part.className).toBe("");
      expect(part.parentElement!.className).toContain("shrink-0");
    }
  });
});
