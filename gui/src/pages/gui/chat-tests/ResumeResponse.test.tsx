import { act, screen, waitFor } from "@testing-library/react";
import type { ChatHistoryItem, Session } from "core";
import { newSession } from "../../../redux/slices/sessionSlice";
import { cancelStream } from "../../../redux/thunks/cancelStream";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import { sendInputWithMockedResponse } from "../../../util/test/utils";
import { RESUME_PROMPT } from "../../../util/resumeTurn";
import { Chat } from "../Chat";

// The messages of the last request, as handed to compileChat
const lastSentMessages = (spy: ReturnType<typeof vi.spyOn>) =>
  (
    spy.mock.calls
      .filter((c: unknown[]) => c[0] === "llm/compileChat")
      .at(-1)?.[1] as any
  ).messages as { role: string; content: unknown }[];

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as { text?: string }[]).map((p) => p.text ?? "").join("");

async function setup() {
  const rendered = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(rendered.store, rendered.ideMessenger);
  });
  rendered.ideMessenger.responses["context/getSymbolsForFiles"] = {};
  return rendered;
}

test("Stop mid-answer offers Resume, which continues from the partial answer", async () => {
  const { ideMessenger, store, user } = await setup();
  const streamChat = vi.spyOn(ideMessenger, "llmStreamChat");
  const request = vi.spyOn(ideMessenger, "request");
  const release = ideMessenger.holdStream();

  await sendInputWithMockedResponse(ideMessenger, "explain", [
    { role: "assistant", content: "The build starts" },
    { role: "assistant", content: " with the config" },
  ]);
  await waitFor(() =>
    expect(store.getState().session.history.at(-1)?.message.content).toBe(
      "The build starts",
    ),
  );
  expect(screen.queryByRole("button", { name: "Resume response" })).toBeNull();

  await act(async () => {
    await store.dispatch(cancelStream());
  });
  release();

  // Keyboard: focus the button and press Enter
  const resume = await screen.findByRole("button", {
    name: "Resume response",
  });
  ideMessenger.chatResponse = [{ role: "assistant", content: " and ends." }];
  resume.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(2));
  const sent = lastSentMessages(request);
  // The partial answer is kept and the model is asked to go on from it
  expect(text(sent.at(-2)?.content)).toBe("The build starts");
  expect(sent.at(-1)?.role).toBe("user");
  expect(text(sent.at(-1)?.content)).toContain(RESUME_PROMPT);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  expect(screen.queryByRole("button", { name: "Resume response" })).toBeNull();
});

test("A session reopened after a reload during reasoning resends its message", async () => {
  const { ideMessenger, store, user } = await setup();
  const streamChat = vi.spyOn(ideMessenger, "llmStreamChat");
  const request = vi.spyOn(ideMessenger, "request");
  const history: ChatHistoryItem[] = [
    {
      message: { role: "user", content: "explain" },
      contextItems: [],
      editorState: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "explain" }] },
        ],
      },
    },
    { message: { role: "assistant", content: "" }, contextItems: [] },
    {
      message: { role: "thinking", content: "Let me look" },
      contextItems: [],
      reasoning: { active: true, text: "Let me look", startAt: 1 },
    },
  ];
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "t",
        workspaceDirectory: "",
        history,
      } as Session),
    );
  });

  const resume = await screen.findByRole("button", {
    name: "Resume response",
  });
  ideMessenger.chatResponse = [{ role: "assistant", content: "It builds." }];
  await user.click(resume);

  await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
  // The message is sent again in its own place: one user turn, no reasoning
  const sent = lastSentMessages(request).filter((m) => m.role !== "system");
  expect(sent.map((m) => m.role)).toEqual(["user"]);
  expect(text(sent[0].content)).toContain("explain");
  await waitFor(() =>
    expect(store.getState().session.history.at(-1)?.message.content).toBe(
      "It builds.",
    ),
  );
  expect(
    store.getState().session.history.filter((h) => h.message.role === "user"),
  ).toHaveLength(1);
});
