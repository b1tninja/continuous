import { act, screen, within } from "@testing-library/react";
import type { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { afterEach, expect, test, vi } from "vitest";
import { newSession } from "../../../redux/slices/sessionSlice";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";
import { messageErrorLine, plainTextOfItem } from "../MessageErrorFallback";

/*
 * One message whose render throws must cost only that message: the others
 * stay, its text can still be read, and no button leaves the conversation.
 */

// A click on a fallback button blurs the prompt, which starts a 100 ms timer.
// Let it run before the test's document is taken down.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});

const BROKEN = "BROKEN-RENDER $$\\frac{1}{0}$$\nsecond line of the reply";

// The reply renderer throws for the one message that holds BROKEN
vi.mock("../../../components/StepContainer", async (importOriginal) => {
  const actual = await importOriginal<{ default: any }>();
  const Real = actual.default;
  return {
    ...actual,
    default: (props: any) => {
      if (String(props.item?.message?.content).includes("BROKEN-RENDER")) {
        const error = new Error("KaTeX could not parse the formula");
        error.stack = "Error: KaTeX could not parse the formula\n    at render";
        throw error;
      }
      return <Real {...props} />;
    },
  };
});

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const item = (
  id: string,
  role: "user" | "assistant",
  content: string,
): ChatHistoryItem => ({
  message: { id, role, content } as ChatHistoryItem["message"],
  contextItems: [],
  ...(role === "user" && { editorState: doc(content) }),
});

const HISTORY = [
  item("u1", "user", "question 1"),
  item("a1", "assistant", "answer 1."),
  item("u2", "user", "question 2"),
  item("a2", "assistant", BROKEN),
  item("u3", "user", "question 3"),
  item("a3", "assistant", "answer 3."),
];

async function setup() {
  // React reports the caught error on the console; keep the test output clean
  vi.spyOn(console, "error").mockImplementation(() => {});
  const rendered = await renderWithProviders(<Chat />);
  const { store, ideMessenger } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });
  ideMessenger.responses["context/getSymbolsForFiles"] = {};
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "keeps-its-session",
        title: "t",
        workspaceDirectory: "",
        history: HISTORY,
      }),
    );
  });
  return rendered;
}

const sessionOf = (store: any) => {
  const { id, history } = store.getState().session;
  return {
    id,
    history: history.map((h: ChatHistoryItem) => [
      (h.message as { id?: string }).id,
      renderChatMessage(h.message),
    ]),
  };
};

test("a message whose render throws says which one, and the others still show", async () => {
  await setup();
  const fallback = await screen.findByTestId("message-error-fallback");
  expect(fallback.textContent).toContain(
    "Message 4 (a reply from the model) could not be drawn.",
  );
  expect(fallback.textContent).not.toContain("KaTeX");
  expect(screen.getAllByTestId("message-error-fallback")).toHaveLength(1);
  expect(await screen.findByText("answer 1.")).toBeTruthy();
  expect(await screen.findByText("answer 3.")).toBeTruthy();
});

test("Show as plain text shows the raw text in place, and no button changes the session", async () => {
  const { store, user } = await setup();
  const fallback = await screen.findByTestId("message-error-fallback");
  const before = sessionOf(store);
  expect(before.id).toBe("keeps-its-session");
  expect(before.history).toHaveLength(HISTORY.length);

  const buttons = within(fallback).getAllByRole("button");
  expect(buttons.map((b) => b.textContent)).toEqual([
    "Show as plain text",
    "Copy details",
  ]);
  for (const button of buttons) {
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
  }
  expect(screen.queryByTestId("message-error-plain-text")).toBeNull();

  await user.click(within(fallback).getByText("Show as plain text"));
  const plain = screen.getByTestId("message-error-plain-text");
  expect(plain.textContent).toBe(BROKEN);
  expect(plain.className).toContain("whitespace-pre-wrap");
  expect(plain.className).toContain("break-words");
  expect(plain.className).toContain("select-text");
  expect(fallback.contains(plain)).toBe(true);
  expect(sessionOf(store)).toEqual(before);

  await user.click(within(fallback).getByText("Copy details"));
  const copied = await navigator.clipboard.readText();
  expect(copied).toContain("KaTeX could not parse the formula");
  expect(copied).toContain("at render");
  expect(await within(fallback).findByText("Details copied")).toBeTruthy();
  expect(sessionOf(store)).toEqual(before);

  await user.click(within(fallback).getByText("Hide plain text"));
  expect(screen.queryByTestId("message-error-plain-text")).toBeNull();
  expect(sessionOf(store)).toEqual(before);

  // Still the same conversation on screen
  expect(screen.getByText("answer 1.")).toBeTruthy();
  expect(screen.getByTestId("message-error-fallback")).toBeTruthy();
});

test("the line names the role in plain words", () => {
  expect(messageErrorLine("user", 1)).toBe(
    "Message 1 (your message) could not be drawn.",
  );
  expect(messageErrorLine("tool", 7)).toBe(
    "Message 7 (a tool result) could not be drawn.",
  );
  expect(messageErrorLine("something-new", 2)).toBe(
    "Message 2 could not be drawn.",
  );
});

test("a reply with no text shows its tool calls as plain text", () => {
  const withCall = {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", function: { name: "read_file" } }],
    },
    contextItems: [],
  } as unknown as ChatHistoryItem;
  expect(plainTextOfItem(withCall)).toContain("read_file");
  expect(plainTextOfItem(item("a", "assistant", ""))).toBe("");
});
