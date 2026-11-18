import type { ChatHistoryItem, ToolCallState } from "core/index.js";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { MemoizedMessage } from "./components/MemoizedMessage.js";
import { hookFlags, ToolResultSummary } from "./ToolResultSummary.js";

/** A frame's text with Ink's wrapping and padding folded back into spaces. */
const flat = (frame: string | undefined) =>
  (frame ?? "").replace(/[│⎿]/g, " ").replace(/\s+/g, " ");

const LONG_REASON =
  "the file names a production database and the policy for this folder says reads of it go through the audited tool, which keeps a record of who asked and why";

function historyWith(status: ToolCallState["status"], content: string) {
  const toolCallState: ToolCallState = {
    toolCallId: "call-1",
    toolCall: {
      id: "call-1",
      type: "function",
      function: { name: "Bash", arguments: '{"command":"cat db.env"}' },
    },
    status,
    parsedArgs: { command: "cat db.env" },
    output: [{ name: "tool_result", content, description: "result" }],
  };
  const item: ChatHistoryItem = {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "Bash", arguments: '{"command":"cat db.env"}' },
        },
      ],
    },
    contextItems: [],
    toolCallStates: [toolCallState],
  };
  return item;
}

describe("reasons are shown whole", () => {
  it("finds the hook flags in a result", () => {
    expect(hookFlags("plain output")).toEqual([]);
    expect(
      hookFlags(
        `out\n\n[Hook output]\nA hook flagged this result: ${LONG_REASON}\nextra context`,
      ),
    ).toEqual([`A hook flagged this result: ${LONG_REASON}`]);
  });

  it("prints a hook's flag in full under a one-line summary", () => {
    const content = `/w/a.ts: 1→x\n\n[Hook output]\nA hook flagged this result: ${LONG_REASON}`;
    const { lastFrame } = render(
      <ToolResultSummary toolName="Read" content={content} />,
    );
    expect(LONG_REASON.length).toBeGreaterThan(100);
    expect(flat(lastFrame())).toContain(LONG_REASON);
  });

  it("prints a hook's flag in full where the summary is clipped", () => {
    const content = `ok\n\n[Hook output]\nA hook flagged this result: ${LONG_REASON}`;
    const { lastFrame } = render(
      <ToolResultSummary toolName="mcp__db__query" content={content} />,
    );
    expect(flat(lastFrame())).toContain(LONG_REASON);
  });

  it("leaves a result with no hook output as it was", () => {
    const { lastFrame } = render(
      <ToolResultSummary toolName="Edit" content="Permission denied by user" />,
    );
    expect(lastFrame()).toContain("Cancelled by user");
  });

  it("prints a policy refusal in full", () => {
    const refusal = `Command blocked by security policy: ${LONG_REASON} Do not retry it or reach the same result another way.`;
    const { lastFrame } = render(
      <MemoizedMessage item={historyWith("canceled", refusal)} index={0} />,
    );
    expect(flat(lastFrame())).toContain(LONG_REASON);
  });

  it("prints a hook's block in full", () => {
    const blocked = `Blocked by a hook: ${LONG_REASON}`;
    const { lastFrame } = render(
      <MemoizedMessage item={historyWith("canceled", blocked)} index={0} />,
    );
    expect(flat(lastFrame())).toContain(LONG_REASON);
  });
});
