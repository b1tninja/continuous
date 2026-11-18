import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../index.js";
import {
  comparePromptParts,
  describePromptDivergence,
  promptDivergenceLogLine,
  promptParts,
  PromptPartsMemory,
  reuseFarBelowPrefix,
} from "./promptDivergence";

const SECRET = "the person's private text, never logged";

const system: ChatMessage = { role: "system", content: "You are an agent." };
const tools = [{ type: "function", function: { name: "read_file" } }];

function conversation(firstUser = `Fix it. ${SECRET}`): ChatMessage[] {
  return [
    system,
    { role: "user", content: firstUser },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: "file body", toolCallId: "c1" },
  ];
}

describe("promptParts", () => {
  it("has the options, the tools, then one part per message, with sizes and no text", () => {
    const parts = promptParts(conversation(), { tools, reasoning: true });
    expect(parts.map((p) => p.kind)).toEqual([
      "options",
      "tools",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(parts[3]).toMatchObject({ index: 1, userNumber: 1 });
    expect(JSON.stringify(parts)).not.toContain(SECRET);
    expect(parts.every((p) => p.chars > 0)).toBe(true);
  });

  it("ignores ids and usage, which the model never reads", () => {
    const a = promptParts([{ role: "user", content: "hi", id: "1" } as any]);
    const b = promptParts([
      { role: "user", content: "hi", id: "2", usage: { promptTokens: 3 } },
    ] as any);
    expect(a.map((p) => p.hash)).toEqual(b.map((p) => p.hash));
  });
});

describe("comparePromptParts", () => {
  it("finds nothing when the next request only adds messages", () => {
    const before = promptParts(conversation(), { tools });
    const after = promptParts(
      [...conversation(), { role: "assistant", content: "Done." }],
      { tools },
    );
    const d = comparePromptParts(before, after);
    expect(d.changed).toBeUndefined();
    expect(d.unchangedChars).toBe(d.previousChars);
  });

  it("names the first changed message: the first user message", () => {
    const before = promptParts(conversation(), { tools });
    const after = promptParts(
      [
        ...conversation("Fix it, and note this."),
        { role: "user", content: "Go" },
      ],
      { tools },
    );
    const d = comparePromptParts(before, after);
    expect(d.at).toBe(3);
    expect(d.changed).toMatchObject({ kind: "user", index: 1, userNumber: 1 });
    expect(describePromptDivergence(d)).toBe(
      "message 2 (your first message) changed: a user message",
    );
    // Only the options, the tools and the system message were unchanged
    expect(d.unchangedChars).toBe(
      before.slice(0, 3).reduce((n, p) => n + p.chars, 0),
    );
  });

  it("names the tool list, the reasoning setting and the system message", () => {
    const base = promptParts(conversation(), { tools, reasoning: true });
    expect(
      describePromptDivergence(
        comparePromptParts(
          base,
          promptParts(conversation(), { tools: [], reasoning: true }),
        ),
      ),
    ).toBe("the tool list changed");
    expect(
      describePromptDivergence(
        comparePromptParts(
          base,
          promptParts(conversation(), { tools, reasoning: false }),
        ),
      ),
    ).toBe("the reasoning or tool-choice setting changed");
    const withRule = conversation();
    withRule[0] = { role: "system", content: "You are an agent.\n\nA rule." };
    expect(
      describePromptDivergence(
        comparePromptParts(
          base,
          promptParts(withRule, { tools, reasoning: true }),
        ),
      ),
    ).toMatch(/^the system message .* changed$/);
  });

  it("names a tool result that was rewritten", () => {
    const before = promptParts(conversation(), { tools });
    const changed = conversation();
    changed[3] = { role: "tool", content: "", toolCallId: "c1" };
    const d = comparePromptParts(before, promptParts(changed, { tools }));
    expect(describePromptDivergence(d)).toBe(
      "message 4 changed: a tool result",
    );
  });

  it("lets the trailing task list go: the next request moves it to its own end", () => {
    const taskList: ChatMessage = { role: "user", content: "<task_list>" };
    const before = promptParts([...conversation(), taskList], { tools });
    const after = promptParts(
      [...conversation(), { role: "assistant", content: "Next." }, taskList],
      { tools },
    );
    expect(comparePromptParts(before, after, 1).changed).toBeUndefined();
    expect(comparePromptParts(before, after, 0).changed?.kind).toBe(
      "assistant",
    );
  });

  it("says the server dropped its cache when the prompt only grew", () => {
    const before = promptParts(conversation(), { tools });
    const d = comparePromptParts(before, before);
    expect(describePromptDivergence(d)).toMatch(/only grew/);
  });
});

describe("reuseFarBelowPrefix", () => {
  const before = promptParts(conversation(), { tools });
  const grown = comparePromptParts(before, before);

  it("is true when the server reused much less than the unchanged prefix", () => {
    // 400k tokens unchanged, 16k reused: the 2026-11-15 misses
    expect(
      reuseFarBelowPrefix(grown, 16_384, 400_000, grown.previousChars),
    ).toBe(true);
  });

  it("is false when the reuse matches what was unchanged", () => {
    expect(
      reuseFarBelowPrefix(grown, 399_000, 400_000, grown.previousChars),
    ).toBe(false);
  });
});

describe("the log line", () => {
  it("has positions and sizes, never message text", () => {
    const before = promptParts(conversation(), { tools });
    const after = promptParts(conversation("changed " + SECRET), { tools });
    const line = promptDivergenceLogLine(comparePromptParts(before, after), {
      readTokens: 16_384,
      promptTokens: 400_398,
    });
    expect(line).toContain("part 3 of 6 (user #1)");
    expect(line).toContain("reused 16384 of 400398 tokens");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("Fix it");
  });
});

describe("PromptPartsMemory", () => {
  it("compares each request with the previous one of the same conversation", () => {
    const memory = new PromptPartsMemory();
    const a = promptParts(conversation(), { tools });
    expect(memory.note("s1", a)).toBeUndefined();
    expect(memory.note("s2", promptParts([system], { tools }))).toBeUndefined();
    const changed = memory.note(
      "s1",
      promptParts(conversation("other"), { tools }),
    );
    expect(changed?.changed?.kind).toBe("user");
  });

  it("keeps a bounded number of conversations", () => {
    const memory = new PromptPartsMemory(2);
    const parts = promptParts([system]);
    memory.note("a", parts);
    memory.note("b", parts);
    memory.note("c", parts);
    expect(memory.note("a", parts)).toBeUndefined();
    expect(memory.note("c", parts)).toBeDefined();
  });

  it("logs nothing by itself", () => {
    const spy = vi.spyOn(console, "debug");
    new PromptPartsMemory().note("s", promptParts(conversation()));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
