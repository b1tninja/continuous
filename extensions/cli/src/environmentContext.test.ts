import type { ChatCompletionMessageParam } from "openai/resources.mjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  capGitStatus,
  ENVIRONMENT_BLOCK_OPEN,
  MAX_GIT_STATUS_CHARS,
  MAX_GIT_STATUS_LINES,
  environmentContextBlock,
  resetEnvironmentContextBlock,
  withEnvironmentBlock,
} from "./environmentContext.js";

afterEach(() => resetEnvironmentContextBlock());

describe("environmentContextBlock", () => {
  it("carries the date and the git status, and is built once per process", () => {
    const block = environmentContextBlock();
    expect(block.startsWith(ENVIRONMENT_BLOCK_OPEN)).toBe(true);
    expect(block).toContain(
      `Today's date: ${new Date().toISOString().split("T")[0]}`,
    );
    expect(block).toContain("Git status at the start of the session");
    expect(block.trimEnd().endsWith("</context>")).toBe(true);
    expect(environmentContextBlock()).toBe(block);
  });
});

describe("capGitStatus", () => {
  const entries = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => ` M src/file${String(i).padStart(4, "0")}.ts`,
    );

  it("leaves a short status as it is", () => {
    const s = " M a.ts\n?? b.ts";
    expect(capGitStatus(s)).toBe(s);
  });

  it("cuts at the line cap with an explicit count of the rest", () => {
    const out = capGitStatus(entries(100).join("\n"));
    const lines = out.split("\n");
    expect(lines).toHaveLength(MAX_GIT_STATUS_LINES + 1);
    expect(lines.at(-1)).toBe(
      `... and ${100 - MAX_GIT_STATUS_LINES} more changed files`,
    );
  });

  it("cuts at the character cap", () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => ` M ${"d/".repeat(60)}f${String(i).padStart(2, "0")}.ts`,
    );
    const out = capGitStatus(long.join("\n"));
    const [last, ...rest] = out.split("\n").reverse();
    expect(last).toMatch(/^\.\.\. and \d+ more changed files$/);
    expect(rest.length).toBeLessThan(MAX_GIT_STATUS_LINES);
    expect(rest.join("\n").length).toBeLessThanOrEqual(MAX_GIT_STATUS_CHARS);
  });

  it("orders by path whatever the input order, so the same tree gives the same bytes", () => {
    const list = entries(60);
    const shuffled = [...list].reverse();
    expect(capGitStatus(shuffled.join("\n"))).toBe(
      capGitStatus(list.join("\n")),
    );
    expect(capGitStatus(shuffled.join("\n")).split("\n")[0]).toBe(list[0]);
  });
});

describe("withEnvironmentBlock", () => {
  const block = '<context name="environment">\nToday: test\n</context>';

  it("appends the block to the first user message only", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "system text" },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const result = withEnvironmentBlock(messages, block);
    expect(result[0]).toEqual({ role: "system", content: "system text" });
    expect(result[1].content).toBe(`first\n\n${block}`);
    expect(result[2]).toEqual({ role: "assistant", content: "reply" });
    expect(result[3].content).toBe("second");
    // The input is left alone: the history must not carry the block
    expect(messages[1].content).toBe("first");
  });

  it("adds a text part when the first user message has parts", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: [{ type: "text", text: "look at this" }],
      },
    ];
    const result = withEnvironmentBlock(messages, block);
    expect(result[0].content).toEqual([
      { type: "text", text: "look at this" },
      { type: "text", text: block },
    ]);
  });

  it("returns the messages unchanged when there is no user message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "only system" },
    ];
    expect(withEnvironmentBlock(messages, block)).toBe(messages);
  });
});
