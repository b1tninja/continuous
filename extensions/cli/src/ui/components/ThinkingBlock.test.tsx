import { render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatHistoryItem } from "../../../../../core/index.js";
import { handleSlashCommands } from "../../slashCommands.js";
import {
  getThinkingDisplay,
  initThinkingDisplay,
  parseThinkingDisplay,
  setThinkingDisplay,
} from "../thinkingDisplay.js";
import { splitChatHistory } from "../utils/historySplitting.js";

import { MemoizedMessage } from "./MemoizedMessage.js";
import { LiveThinking, liveTail } from "./ThinkingBlock.js";

const reply = (extra: Partial<ChatHistoryItem> = {}): ChatHistoryItem =>
  ({
    message: { role: "assistant", content: "The answer is 4." },
    contextItems: [],
    reasoning: {
      active: false,
      text: "Two plus two.\nCarry nothing.",
      startAt: 1000,
      endAt: 5200,
    },
    ...extra,
  }) as ChatHistoryItem;

afterEach(() => {
  setThinkingDisplay("fold");
});

describe("the reasoning in the terminal UI", () => {
  it("shows the live reasoning dimmed under a Thinking header, newest lines only", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const { lastFrame } = render(<LiveThinking text={text} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Thinking…");
    expect(frame).toContain("line 20");
    expect(frame).toContain("line 13");
    expect(frame).not.toContain("line 12\n");
    expect(liveTail("x".repeat(5000)).length).toBeLessThan(1300);
  });

  it("folds a finished reply's reasoning to one line above the answer", () => {
    const { lastFrame } = render(
      <MemoizedMessage item={reply()} index={1} thinkingDisplay="fold" />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Thought for 4s");
    expect(frame).toContain("The answer is 4.");
    expect(frame).not.toContain("Carry nothing.");
    expect(frame.indexOf("Thought for")).toBeLessThan(
      frame.indexOf("The answer"),
    );
  });

  it("keeps the reasoning under the line when expanded, and shows none when hidden", () => {
    const expanded = render(
      <MemoizedMessage item={reply()} index={1} thinkingDisplay="expanded" />,
    ).lastFrame()!;
    expect(expanded).toContain("Thought for 4s");
    expect(expanded).toContain("Carry nothing.");

    const hidden = render(
      <MemoizedMessage item={reply()} index={1} thinkingDisplay="hide" />,
    ).lastFrame()!;
    expect(hidden).not.toContain("Thought for");
    expect(hidden).toContain("The answer is 4.");
  });

  it("shows the line above a reply's tool calls too, and nothing for a reply without reasoning", () => {
    const toolCall = {
      id: "t1",
      type: "function" as const,
      function: { name: "Read", arguments: "{}" },
    };
    const withTools = reply({
      message: { role: "assistant", content: "", toolCalls: [toolCall] },
      toolCallStates: [
        { toolCallId: "t1", toolCall, status: "done", parsedArgs: {} },
      ],
    } as any);
    expect(
      render(<MemoizedMessage item={withTools} index={1} />).lastFrame(),
    ).toContain("Thought for 4s");

    const plain = reply({ reasoning: undefined });
    expect(
      render(<MemoizedMessage item={plain} index={1} />).lastFrame(),
    ).not.toContain("Thought for");
  });

  it("shows the line once when a long reply is split for display", () => {
    const long = reply({
      message: {
        role: "assistant",
        content: Array.from({ length: 200 }, (_, i) => `Paragraph ${i}.`).join(
          "\n\n",
        ),
      },
    });
    const pieces = splitChatHistory([long], 80);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.filter((p) => p.reasoning)).toHaveLength(1);
    expect(pieces[0].reasoning).toBeDefined();
  });
});

describe("the thinking display setting", () => {
  it("reads the flag, then the variable, and refuses an unknown flag", () => {
    expect(initThinkingDisplay("hide", {})).toBe("hide");
    expect(
      initThinkingDisplay(undefined, { CONTINUE_CLI_THINKING: "expanded" }),
    ).toBe("expanded");
    expect(initThinkingDisplay("show", {})).toBe("fold");
    expect(() => initThinkingDisplay("loud", {})).toThrow(/--thinking/);
    expect(parseThinkingDisplay("off")).toBe("hide");
    expect(parseThinkingDisplay("nope")).toBeUndefined();
  });

  it("is changed by /thinking", async () => {
    const assistant = {} as any;
    expect(
      (await handleSlashCommands("/thinking expanded", assistant))?.output,
    ).toBe("Thinking display: expanded");
    expect(getThinkingDisplay()).toBe("expanded");
    expect(
      (await handleSlashCommands("/thinking", assistant))?.output,
    ).toContain("expanded");
    expect(
      (await handleSlashCommands("/thinking loud", assistant))?.output,
    ).toContain("not a thinking display");
    expect(getThinkingDisplay()).toBe("expanded");
  });
});
