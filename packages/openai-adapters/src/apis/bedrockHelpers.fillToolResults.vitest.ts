import { describe, expect, it } from "vitest";

import { fillMissingToolResults } from "./bedrockHelpers.js";

const use = (toolUseId: string) => ({ toolUse: { toolUseId } });
const result = (toolUseId: string, text = "output") => ({
  toolResult: { toolUseId, content: [{ text }] },
});
const CANCELLED = "cancelled";

describe("fillMissingToolResults", () => {
  it("puts the result first in the user message after the call", () => {
    const filled = fillMissingToolResults(
      [
        { role: "user", content: [{ text: "ask" }] },
        { role: "assistant", content: [use("a")] },
        { role: "user", content: [{ text: "steer" }] },
      ],
      CANCELLED,
    );
    expect(filled).toHaveLength(3);
    expect(filled[2].content).toEqual([
      result("a", CANCELLED),
      { text: "steer" },
    ]);
  });

  it("adds a user message when the history ends on the call", () => {
    const filled = fillMissingToolResults(
      [{ role: "assistant", content: [use("a")] }],
      CANCELLED,
    );
    expect(filled[1]).toEqual({
      role: "user",
      content: [result("a", CANCELLED)],
    });
  });

  it("adds a user message between two assistant messages", () => {
    const filled = fillMissingToolResults(
      [
        { role: "assistant", content: [use("a")] },
        { role: "assistant", content: [{ text: "next" }] },
      ],
      CANCELLED,
    );
    expect(filled.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("fills only the calls of a parallel set that have no result", () => {
    const filled = fillMissingToolResults(
      [
        { role: "assistant", content: [use("a"), use("b")] },
        { role: "user", content: [result("b")] },
      ],
      CANCELLED,
    );
    expect(filled[1].content).toEqual([result("a", CANCELLED), result("b")]);
  });

  it("leaves a complete conversation as it was", () => {
    const messages = [
      { role: "assistant", content: [use("a")] },
      { role: "user", content: [result("a")] },
      { role: "assistant", content: [{ text: "done" }] },
    ];
    const before = structuredClone(messages);
    expect(fillMissingToolResults(messages, CANCELLED)).toEqual(before);
  });

  // The shape of a session Bedrock refused on resume (messages.330): a turn
  // cut off mid-call left a call with no id (sent as text) and its result,
  // also text, ahead of the real call's result.
  it("moves a result ahead of text that came before it", () => {
    const filled = fillMissingToolResults(
      [
        { role: "user", content: [{ text: "ask" }] },
        {
          role: "assistant",
          content: [{ text: "Tool call (no id)" }, use("b")],
        },
        {
          role: "user",
          content: [{ text: "Tool call output (no id)" }, result("b", "out b")],
        },
      ],
      CANCELLED,
    );
    expect(filled[2].content).toEqual([
      result("b", "out b"),
      { text: "Tool call output (no id)" },
    ]);
  });

  it("orders backfilled results, then existing results, then the rest", () => {
    const filled = fillMissingToolResults(
      [
        { role: "assistant", content: [use("a"), use("b")] },
        {
          role: "user",
          content: [
            { text: "user note" },
            result("b", "out b"),
            { cachePoint: {} },
          ],
        },
      ],
      CANCELLED,
    );
    expect(filled[1].content).toEqual([
      result("a", CANCELLED),
      result("b", "out b"),
      { text: "user note" },
      { cachePoint: {} },
    ]);
  });

  it("keeps the order of parallel results that are already first", () => {
    const content = [result("b", "out b"), result("a", "out a"), { text: "t" }];
    const messages = [
      { role: "assistant", content: [use("a"), use("b")] },
      { role: "user", content },
    ];
    const filled = fillMissingToolResults(messages, CANCELLED);
    // Unchanged: the same array, not a copy
    expect(filled[1].content).toBe(content);
  });

  it("leaves a result for a different call where it is", () => {
    const filled = fillMissingToolResults(
      [
        { role: "assistant", content: [use("a")] },
        {
          role: "user",
          content: [{ text: "t" }, result("z", "stray"), result("a", "out a")],
        },
      ],
      CANCELLED,
    );
    expect(filled[1].content).toEqual([
      result("a", "out a"),
      { text: "t" },
      result("z", "stray"),
    ]);
  });

  it("does nothing to an assistant turn without calls", () => {
    const content = [{ text: "t" }, result("a", "x")];
    const messages = [
      { role: "assistant", content: [{ text: "hi" }] },
      { role: "user", content },
    ];
    expect(fillMissingToolResults(messages, CANCELLED)[1].content).toBe(
      content,
    );
  });
});
