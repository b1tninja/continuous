import { describe, expect, it, vi } from "vitest";
import type { ChatHistoryItem, Session } from "..";
import {
  compactConversation,
  spanNote,
  summarizeConversation,
} from "./conversationCompaction";

/** Planned compaction (C105): a summary made ahead, then saved as it is. */

function history(): ChatHistoryItem[] {
  return [
    { message: { role: "user", content: "start" }, contextItems: [] },
    {
      message: { role: "assistant", content: "first reply" },
      contextItems: [],
    },
    { message: { role: "user", content: "more" }, contextItems: [] },
    { message: { role: "assistant", content: "latest" }, contextItems: [] },
  ];
}

function session(): Session {
  return {
    sessionId: "s1",
    title: "t",
    workspaceDirectory: "",
    history: history(),
  };
}

describe("planned compaction in core", () => {
  it("saves a prepared summary without asking the model, keeping every message", async () => {
    const historyManager = { load: vi.fn(session), save: vi.fn() } as any;
    const currentModel = { chat: vi.fn() } as any;

    await compactConversation({
      sessionId: "s1",
      index: 1,
      historyManager,
      currentModel,
      summary: "prepared",
    });

    expect(currentModel.chat).not.toHaveBeenCalled();
    const saved = historyManager.save.mock.calls[0][0] as Session;
    expect(saved.history).toHaveLength(4);
    expect(saved.history[1].conversationSummary).toBe("prepared");
    expect(saved.history.map((h) => h.message.content)).toEqual(
      history().map((h) => h.message.content),
    );
  });

  it("refuses an index the saved session does not have", async () => {
    const historyManager = { load: vi.fn(session), save: vi.fn() } as any;
    await expect(
      compactConversation({
        sessionId: "s1",
        index: 9,
        historyManager,
        currentModel: { chat: vi.fn() } as any,
        summary: "prepared",
      }),
    ).rejects.toThrow("No message 9");
    expect(historyManager.save).not.toHaveBeenCalled();
  });

  it("summarizeConversation returns the summary, saves nothing, and passes the signal", async () => {
    const historyManager = { load: vi.fn(session), save: vi.fn() } as any;
    const chat = vi.fn(async () => ({
      role: "assistant",
      content: "the summary",
    }));
    const controller = new AbortController();

    const summary = await summarizeConversation({
      sessionId: "s1",
      index: 1,
      historyManager,
      currentModel: { chat } as any,
      signal: controller.signal,
    });

    expect(summary).toBe("the summary");
    expect(historyManager.save).not.toHaveBeenCalled();
    const [messages, signal] = chat.mock.calls[0] as unknown as [
      { content: string }[],
      AbortSignal,
    ];
    expect(signal).toBe(controller.signal);
    // Without a prefix only the span is sent: items 0 and 1, then the prompt
    expect(messages.map((m) => m.content).slice(0, 2)).toEqual([
      "start",
      "first reply",
    ]);
    expect(messages).toHaveLength(3);
  });

  it("with the whole conversation as prefix, says where the span ends", async () => {
    const historyManager = { load: vi.fn(session), save: vi.fn() } as any;
    const chat = vi.fn(async () => ({ role: "assistant", content: "s" }));
    const prefix = [
      { role: "system" as const, content: "sys" },
      ...history().map((h) => h.message),
    ];
    await summarizeConversation({
      sessionId: "s1",
      index: 1,
      historyManager,
      currentModel: { chat } as any,
      conversationPrefix: { messages: prefix, options: {} },
    });
    const [messages] = chat.mock.calls[0] as unknown as [{ content: string }[]];
    expect(messages).toHaveLength(prefix.length + 1);
    expect(messages[messages.length - 1].content).toContain(
      'Summarise only the conversation up to and including the message that begins "first reply".',
    );
  });

  it.each([
    { index: 3, note: "" },
    { index: 1, note: 'begins "first reply"' },
  ])("spanNote at $index", ({ index, note }) => {
    const text = spanNote(history(), index);
    if (note) expect(text).toContain(note);
    else expect(text).toBe("");
  });

  it("an aborted summary request rejects", async () => {
    const historyManager = { load: vi.fn(session), save: vi.fn() } as any;
    const controller = new AbortController();
    const chat = vi.fn(
      (_m: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const pending = summarizeConversation({
      sessionId: "s1",
      index: 1,
      historyManager,
      currentModel: { chat } as any,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(historyManager.save).not.toHaveBeenCalled();
  });
});
