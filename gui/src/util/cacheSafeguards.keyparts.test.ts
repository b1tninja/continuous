import type { ChatMessage, ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import { stableJson } from "./cacheKeyParts";
import {
  keyChanges,
  promptCacheKey,
  type PromptCacheKeyExtras,
} from "./cacheSafeguards";

const sonnet: ModelDescription = {
  title: "s",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
};

const tool = (name: string, description = "d", parameters: object = {}) => ({
  type: "function" as const,
  function: { name, description, parameters },
});

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const withImage: ChatMessage = {
  role: "user",
  content: [
    { type: "text", text: "see" },
    { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
  ],
};

const key = (
  over: {
    tools?: ReturnType<typeof tool>[];
    options?: PromptCacheKeyExtras["options"];
    messages?: ChatMessage[];
  } = {},
) =>
  promptCacheKey(
    sonnet,
    over.tools ?? [tool("read_file")],
    "sys",
    over.messages ?? [user("hi")],
    { options: over.options ?? {} },
  );

describe("miss key: tool definitions", () => {
  it("stableJson ignores key order", () => {
    expect(stableJson({ a: 1, b: { d: 1, c: 2 } })).toBe(
      stableJson({ b: { c: 2, d: 1 }, a: 1 }),
    );
  });

  it("a changed description with the same names is a tools change", () => {
    const a = key();
    const b = key({ tools: [tool("read_file", "updated by the MCP server")] });
    expect(keyChanges(a, b)).toEqual(["the tools changed"]);
  });

  it("a changed input schema is a tools change", () => {
    const a = key({ tools: [tool("t", "d", { type: "object" })] });
    const b = key({
      tools: [tool("t", "d", { type: "object", required: ["x"] })],
    });
    expect(keyChanges(a, b)).toEqual(["the tools changed"]);
  });

  it("the same tools with reordered schema keys are unchanged", () => {
    const a = key({ tools: [tool("t", "d", { a: 1, b: 2 })] });
    const b = key({ tools: [tool("t", "d", { b: 2, a: 1 })] });
    expect(keyChanges(a, b)).toEqual([]);
  });

  it("plain names still work as a list of strings", () => {
    const a = promptCacheKey(sonnet, ["a", "b"], "s");
    const b = promptCacheKey(sonnet, ["a", "c"], "s");
    expect(keyChanges(a, b)).toEqual(["the tools changed"]);
  });
});

describe("miss key: request settings", () => {
  it("names a reasoning change", () => {
    const a = key({
      options: { reasoning: true, reasoningBudgetTokens: 2000 },
    });
    const b = key({
      options: { reasoning: true, reasoningBudgetTokens: 8000 },
    });
    expect(keyChanges(a, b)).toEqual([
      "the reasoning effort or thinking settings changed",
    ]);
  });

  it("names a tool choice change", () => {
    const a = key();
    const b = key({
      options: { toolChoice: { type: "function", function: { name: "x" } } },
    });
    expect(keyChanges(a, b)).toEqual(["the tool choice changed"]);
  });

  it("names an image appearing and going", () => {
    const a = key();
    const b = key({ messages: [user("hi"), withImage] });
    expect(keyChanges(a, b)).toEqual(["an image was added"]);
    expect(keyChanges(b, a)).toContain("an image was removed");
  });

  it("lists every cause when several changed", () => {
    const a = key();
    const b = key({
      tools: [tool("read_file", "new")],
      options: { reasoning: true },
      messages: [user("hi"), withImage],
    });
    expect(keyChanges(a, b)).toEqual([
      "the tools changed",
      "the reasoning effort or thinking settings changed",
      "an image was added",
    ]);
  });

  it("says nothing for keys made without options (older keys)", () => {
    const old = promptCacheKey(sonnet, [tool("read_file")], "sys", [
      user("hi"),
    ]);
    expect(keyChanges(old, key({ options: { reasoning: true } }))).toEqual([]);
  });

  it("a route given as a plain string still names the account", () => {
    expect(promptCacheKey(sonnet, [], "s", [], "acct").model).toContain(
      "via acct",
    );
  });
});
