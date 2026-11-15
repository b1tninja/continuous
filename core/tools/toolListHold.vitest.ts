import { describe, expect, it } from "vitest";
import {
  countToolChanges,
  describeToolChanges,
  functionFingerprint,
  pendingToolChanges,
  pendingToolChangesText,
  resolveToolList,
  sameToolList,
  thinkingCutAfterToolChange,
  toolChangeDropsThinking,
  toolChangeTiming,
  toolChangeWarning,
  toolChangesId,
  withheldToolRefusal,
} from "./toolListHold";

interface T {
  function: { name: string; description?: string };
}
const tool = (name: string, description = name): T => ({
  function: { name, description },
});
const nameOf = (t: T) => t.function.name;
const opts = { nameOf, fingerprintOf: functionFingerprint };

describe("toolChangeTiming", () => {
  it("queues only while warm and significant", () => {
    expect(toolChangeTiming({ warm: true, significant: true })).toBe("queue");
    expect(toolChangeTiming({ warm: false, significant: true })).toBe(
      "immediate",
    );
    expect(toolChangeTiming({ warm: true, significant: false })).toBe(
      "immediate",
    );
  });

  it("applies at once when the person turned the wait off", () => {
    expect(
      toolChangeTiming({ warm: true, significant: true, applyAtOnce: true }),
    ).toBe("immediate");
  });
});

describe("pendingToolChanges", () => {
  it("names added, removed and changed tools", () => {
    const p = pendingToolChanges(
      [tool("a"), tool("b"), tool("c")],
      [tool("a"), tool("c", "new text"), tool("d")],
      nameOf,
      functionFingerprint,
    );
    expect(p).toEqual({ added: ["d"], removed: ["b"], changed: ["c"] });
    expect(countToolChanges(p)).toBe(3);
    expect(describeToolChanges(p)).toBe("+d, -b, ~c");
  });

  it("gives the same id whatever the order", () => {
    expect(toolChangesId({ added: ["b", "a"], removed: [], changed: [] })).toBe(
      toolChangesId({ added: ["a", "b"], removed: [], changed: [] }),
    );
  });
});

describe("resolveToolList", () => {
  const held = { key: "agent", tools: [tool("a"), tool("b")] };

  it("keeps the held list while the hold is on and something changed", () => {
    const r = resolveToolList({
      live: [tool("a"), tool("c")],
      held,
      key: "agent",
      hold: true,
      ...opts,
    });
    expect(r.held).toBe(true);
    expect(r.tools.map(nameOf)).toEqual(["a", "b"]);
    expect(r.pending).toEqual({ added: ["c"], removed: ["b"], changed: [] });
  });

  it("applies the change once the hold is off (the cache went cold)", () => {
    const r = resolveToolList({
      live: [tool("a"), tool("c")],
      held,
      key: "agent",
      hold: false,
      ...opts,
    });
    expect(r.held).toBe(false);
    expect(r.tools.map(nameOf)).toEqual(["a", "c"]);
    expect(countToolChanges(r.pending)).toBe(0);
  });

  it("drops the held list when the context changed (a mode switch)", () => {
    const r = resolveToolList({
      live: [tool("a")],
      held,
      key: "plan",
      hold: true,
      ...opts,
    });
    expect(r.held).toBe(false);
    expect(r.tools.map(nameOf)).toEqual(["a"]);
  });

  it("uses the live list when nothing is held or nothing changed", () => {
    expect(
      resolveToolList({
        live: [tool("x")],
        held: undefined,
        key: "agent",
        hold: true,
        ...opts,
      }).tools.map(nameOf),
    ).toEqual(["x"]);
    const same = resolveToolList({
      live: [tool("a"), tool("b")],
      held,
      key: "agent",
      hold: true,
      ...opts,
    });
    expect(same.held).toBe(false);
  });

  it("holds a description change too: it changes the prompt bytes", () => {
    const r = resolveToolList({
      live: [tool("a", "edited"), tool("b")],
      held,
      key: "agent",
      hold: true,
      ...opts,
    });
    expect(r.held).toBe(true);
    expect(r.tools[0].function.description).toBe("a");
    expect(r.pending.changed).toEqual(["a"]);
  });
});

describe("texts", () => {
  it("says why a withheld tool is refused", () => {
    expect(withheldToolRefusal("search_web")).toMatch(
      /^search_web is turned off for this session; the change applies when the prompt cache goes cold\./,
    );
    expect(withheldToolRefusal("gh_issue", true)).toMatch(
      /no longer available in this session/,
    );
    expect(withheldToolRefusal("x")).toMatch(/Do not retry this call/);
  });

  it("words the warning and the pending line", () => {
    expect(toolChangeWarning("100k tokens at full price")).toBe(
      "Prompt cache is warm: changing the tool list re-reads about 100k tokens at full price on the next request.",
    );
    expect(pendingToolChangesText(1)).toBe(
      "1 tool change waiting for the cache to cool",
    );
    expect(pendingToolChangesText(2)).toBe(
      "2 tool changes waiting for the cache to cool",
    );
  });
});

describe("preserved thinking (PR #893)", () => {
  it("knows the models whose prefix check refuses old thinking", () => {
    for (const id of [
      "claude-fable-5-2",
      "claude-mythos-5-2",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "us.anthropic.claude-sonnet-5-5-20261001-v1:0",
      "claude-haiku-5-5",
    ]) {
      expect(toolChangeDropsThinking(id), id).toBe(true);
    }
    for (const id of [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "gpt-5",
      undefined,
    ]) {
      expect(toolChangeDropsThinking(id), String(id)).toBe(false);
    }
  });

  it("cuts at the request that changes the list, and keeps the cut after", () => {
    const at = (listChanged: boolean, previous?: number) =>
      thinkingCutAfterToolChange({
        modelId: "claude-fable-5-2",
        listChanged,
        historyLength: 12,
        previous,
      });
    expect(at(true)).toBe(12);
    expect(at(false, 7)).toBe(7);
    expect(at(false)).toBeUndefined();
    expect(
      thinkingCutAfterToolChange({
        modelId: "claude-sonnet-4-6",
        listChanged: true,
        historyLength: 12,
      }),
    ).toBeUndefined();
  });

  it("compares lists by their bytes", () => {
    expect(sameToolList([tool("a")], [tool("a")], functionFingerprint)).toBe(
      true,
    );
    expect(
      sameToolList([tool("a")], [tool("a", "x")], functionFingerprint),
    ).toBe(false);
  });

  it("says so in the warning", () => {
    expect(toolChangeWarning("1k tokens", true)).toBe(
      "Prompt cache is warm: changing the tool list re-reads about 1k tokens on the next request; on this model it rebuilds the cache and drops earlier reasoning.",
    );
  });
});
