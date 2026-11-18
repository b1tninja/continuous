import { describe, expect, it } from "vitest";

import {
  CONVERSE_LEADING_USER_TEXT,
  repairConverseTurns,
} from "./bedrockHelpers.js";

const text = (t: string) => ({ text: t });
const use = (toolUseId: string) => ({
  toolUse: { toolUseId, name: "read", input: {} },
});
const result = (toolUseId: string, t = "output") => ({
  toolResult: { toolUseId, content: [{ text: t }] },
});
const cachePoint = { cachePoint: { type: "default" } };

describe("repairConverseTurns", () => {
  it("returns a valid conversation as it was, message objects included", () => {
    const messages = [
      { role: "user", content: [text("ask")] },
      { role: "assistant", content: [text("calling"), use("a")] },
      { role: "user", content: [result("a"), text("more"), cachePoint] },
      { role: "assistant", content: [text("done")] },
    ];
    const before = JSON.stringify(messages);
    const repaired = repairConverseTurns(messages);
    expect(JSON.stringify(repaired)).toBe(before);
    repaired.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it("drops an empty assistant turn and joins the user turns around it", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [] },
      { role: "user", content: [text("two")] },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: [text("one"), text("two")] },
    ]);
  });

  it("drops an empty user turn and joins the assistant turns around it", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [use("a")] },
      { role: "user", content: [] },
      { role: "assistant", content: [text("more")] },
      { role: "user", content: [result("a")] },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [use("a"), text("more")] },
      { role: "user", content: [result("a")] },
    ]);
  });

  it("joins messages of the same role that arrive in a row", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [text("one")] },
      { role: "user", content: [text("two")] },
      { role: "assistant", content: [text("a")] },
      { role: "assistant", content: [text("b")] },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: [text("one"), text("two")] },
      { role: "assistant", content: [text("a"), text("b")] },
    ]);
  });

  it("drops blank text blocks, and a message left with nothing", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [text("one"), text("  ")] },
      { role: "assistant", content: [text("\n")] },
      { role: "user", content: [text(""), text("two")] },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: [text("one"), text("two")] },
    ]);
  });

  it("keeps a cache point only where it follows content", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [text("one"), cachePoint] },
      { role: "assistant", content: [text(" "), cachePoint] },
      { role: "user", content: [cachePoint, text("two"), cachePoint] },
    ]);
    expect(repaired).toEqual([
      {
        role: "user",
        content: [text("one"), cachePoint, text("two"), cachePoint],
      },
    ]);
  });

  it("turns a toolResult whose toolUse is not in the message before into text", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [use("a")] },
      { role: "user", content: [text("steer")] },
      { role: "assistant", content: [] },
      { role: "user", content: [result("a", "late")] },
    ]);
    // Joining the user turns put the result right after its call again
    expect(repaired).toEqual([
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [use("a")] },
      { role: "user", content: [text("steer"), result("a", "late")] },
    ]);

    const orphaned = repairConverseTurns([
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [use("a")] },
      { role: "user", content: [result("a")] },
      { role: "assistant", content: [text("ok")] },
      { role: "user", content: [result("a", "again"), result("b", "")] },
    ]);
    expect(orphaned[4].content).toEqual([
      text("Tool call output for Tool Call ID a:\n\nagain"),
      text("Tool call output for Tool Call ID b:\n\nNo tool output"),
    ]);
    expect(orphaned[2].content).toEqual([result("a")]);
  });

  it("starts the conversation with a user message", () => {
    const repaired = repairConverseTurns([
      { role: "user", content: [] },
      { role: "assistant", content: [text("hello")] },
      { role: "user", content: [text("hi")] },
    ]);
    expect(repaired).toEqual([
      { role: "user", content: [text(CONVERSE_LEADING_USER_TEXT)] },
      { role: "assistant", content: [text("hello")] },
      { role: "user", content: [text("hi")] },
    ]);
  });

  it("returns no messages for no content", () => {
    expect(
      repairConverseTurns([
        { role: "user", content: [] },
        { role: "assistant", content: [text("")] },
      ]),
    ).toEqual([]);
  });

  it("does not change the messages it was given", () => {
    const messages = [
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [text(" ")] },
      { role: "user", content: [text("two")] },
    ];
    const before = JSON.stringify(messages);
    repairConverseTurns(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
