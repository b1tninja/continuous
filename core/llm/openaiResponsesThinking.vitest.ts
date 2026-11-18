import { describe, expect, test } from "vitest";
import { fromResponsesChunk } from "./openaiTypeConverters.js";

function messages(events: any[]) {
  return events.flatMap((e) => {
    const m = fromResponsesChunk(e);
    return m === undefined ? [] : Array.isArray(m) ? m : [m];
  });
}

describe("Responses API reasoning summaries", () => {
  test("the summary's text is content once: from the deltas, not again at done", () => {
    const out = messages([
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "Checking ",
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "the tests.",
      },
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_1",
        text: "Checking the tests.",
      },
    ]);
    expect(out.every((m) => m.role === "thinking")).toBe(true);
    expect(out.map((m) => m.content).join("")).toBe("Checking the tests.");
    // What is sent back (reasoning_details) still has the done event's text
    expect((out[2] as any).reasoning_details).toEqual([
      { type: "summary_text", text: "Checking the tests." },
      { type: "reasoning_id", id: "rs_1" },
    ]);
  });

  test("raw reasoning text is content once too", () => {
    const out = messages([
      { type: "response.reasoning_text.delta", item_id: "rs_2", delta: "a" },
      { type: "response.reasoning_text.done", item_id: "rs_2", text: "a" },
    ]);
    expect(out.map((m) => m.content).join("")).toBe("a");
  });
});
