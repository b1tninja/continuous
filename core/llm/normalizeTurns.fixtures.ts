/**
 * Histories for the normalizeTurns tests: one per case in the provider
 * message validity audit, and valid ones every provider accepts.
 */
import type { ChatMessage } from "../index.js";
import { CANCELLED_TOOL_CALL_MESSAGE } from "../tools/constants.js";
import type { TurnRepair } from "./normalizeTurns.js";

export const call = (
  id: string | undefined,
  name: string | undefined,
  args = "{}",
) =>
  ({
    ...(id !== undefined && { id }),
    type: "function" as const,
    function: {
      ...(name !== undefined && { name }),
      arguments: args,
    },
  }) as any;

export const user = (content: ChatMessage["content"]): ChatMessage =>
  ({ role: "user", content }) as ChatMessage;
export const assistant = (
  content: ChatMessage["content"],
  toolCalls?: any[],
): ChatMessage =>
  ({
    role: "assistant",
    content,
    ...(toolCalls && { toolCalls }),
  }) as ChatMessage;
export const thinking = (content: string, signature?: string): ChatMessage => ({
  role: "thinking",
  content,
  ...(signature && { signature }),
});
export const tool = (
  toolCallId: string | undefined,
  content = "ok",
): ChatMessage => ({ role: "tool", content, toolCallId }) as ChatMessage;
export const cancelled = (toolCallId: string): ChatMessage => ({
  role: "tool",
  content: CANCELLED_TOOL_CALL_MESSAGE,
  toolCallId,
});

export interface TurnCase {
  name: string;
  input: ChatMessage[];
  expected: ChatMessage[];
  repairs: TurnRepair[];
  requiresAlternation?: boolean;
}

// One fixture per case in the audit table (plans/research/
// provider-message-validity-audit.md, "Provider by case"), then the GUI and
// CLI shapes it names.
export const turnCases: TurnCase[] = [
  {
    name: "1. empty assistant",
    input: [user("hi"), assistant(""), user("again")],
    expected: [user("hi"), user("again")],
    repairs: ["dropped-empty-assistant"],
  },
  {
    name: "1. assistant with blank array content",
    input: [user("hi"), assistant([{ type: "text", text: "  " }]), user("x")],
    expected: [user("hi"), user("x")],
    repairs: ["dropped-empty-assistant"],
  },
  {
    name: "1. assistant with toolCalls: []",
    input: [user("hi"), assistant("answer", []), user("x")],
    expected: [user("hi"), assistant("answer"), user("x")],
    repairs: ["removed-empty-tool-calls"],
  },
  {
    name: "1. empty assistant with toolCalls: []",
    input: [user("hi"), assistant("", []), user("x")],
    expected: [user("hi"), user("x")],
    repairs: ["removed-empty-tool-calls", "dropped-empty-assistant"],
  },
  {
    name: "2. empty user",
    input: [user("hi"), assistant("a"), user(" "), user("real")],
    expected: [user("hi"), assistant("a"), user("real")],
    repairs: ["dropped-empty-user"],
  },
  {
    name: "2. empty array user",
    input: [user([]), user("real")],
    expected: [user("real")],
    repairs: ["dropped-empty-user"],
  },
  {
    name: "2. every user empty keeps the last one",
    input: [user(""), assistant("a"), user("")],
    expected: [assistant("a"), user("")],
    repairs: ["dropped-empty-user"],
  },
  {
    name: "3. assistant with only thinking (unsigned)",
    input: [user("hi"), thinking("hmm"), user("again")],
    expected: [user("hi"), user("again")],
    repairs: ["dropped-orphan-thinking"],
  },
  {
    name: "3. signed thinking before an empty assistant",
    input: [user("hi"), thinking("hmm", "sig"), assistant(""), user("x")],
    expected: [user("hi"), user("x")],
    repairs: ["dropped-orphan-thinking", "dropped-empty-assistant"],
  },
  {
    name: "3. thinking after the answer, before the next user turn",
    input: [
      user("hi"),
      thinking("a", "sig"),
      assistant("answer"),
      thinking("late"),
      user("x"),
    ],
    expected: [
      user("hi"),
      thinking("a", "sig"),
      assistant("answer"),
      user("x"),
    ],
    repairs: ["dropped-orphan-thinking"],
  },
  {
    name: "4. tool call with no id gets a deterministic id; its id-less result is matched",
    input: [
      user("hi"),
      assistant("", [call(undefined, "read")]),
      tool(undefined, "file"),
    ],
    expected: [
      user("hi"),
      assistant("", [call("call_1_0", "read")]),
      tool("call_1_0", "file"),
    ],
    repairs: ["added-tool-call-id", "matched-tool-result-id"],
  },
  {
    name: "4. tool call with no name is removed and its result becomes text",
    input: [
      user("hi"),
      assistant("let me look", [call("c1", undefined), call("c2", "read")]),
      tool("c1", "one"),
      tool("c2", "two"),
    ],
    expected: [
      user("hi"),
      assistant("let me look", [call("c2", "read")]),
      tool("c2", "two"),
      user("Tool call output for Tool Call ID c1:\n\none"),
    ],
    repairs: [
      "removed-unnamed-tool-call",
      "orphan-tool-result-to-text",
      "moved-user-after-tool-results",
    ],
  },
  {
    name: "4. the only call has no name: the empty turn goes too",
    input: [user("hi"), assistant("", [call("c1", "")]), tool("c1"), user("x")],
    expected: [
      user("hi"),
      user("Tool call output for Tool Call ID c1:\n\nok"),
      user("x"),
    ],
    repairs: [
      "removed-unnamed-tool-call",
      "dropped-empty-assistant",
      "orphan-tool-result-to-text",
    ],
  },
  {
    name: "5a. tool result with no matching call",
    input: [user("hi"), assistant("a"), tool("ghost", "out"), user("x")],
    expected: [
      user("hi"),
      assistant("a"),
      user("Tool call output for Tool Call ID ghost:\n\nout"),
      user("x"),
    ],
    repairs: ["orphan-tool-result-to-text"],
  },
  {
    name: "5a. a duplicate result is an orphan",
    input: [
      user("hi"),
      assistant("", [call("c1", "read")]),
      tool("c1", "first"),
      tool("c1", "second"),
    ],
    expected: [
      user("hi"),
      assistant("", [call("c1", "read")]),
      tool("c1", "first"),
      user("Tool call output for Tool Call ID c1:\n\nsecond"),
    ],
    repairs: ["orphan-tool-result-to-text"],
  },
  {
    name: "5a. empty orphan output",
    input: [user("hi"), tool("x", "  ")],
    expected: [
      user("hi"),
      user("Tool call output for Tool Call ID x:\n\nNo tool output"),
    ],
    repairs: ["orphan-tool-result-to-text"],
  },
  {
    name: "5b. tool call with no result (a call with no toolCallState)",
    input: [
      user("hi"),
      assistant("", [call("c1", "read"), call("c2", "write")]),
      tool("c2"),
      user("next"),
    ],
    expected: [
      user("hi"),
      assistant("", [call("c1", "read"), call("c2", "write")]),
      tool("c2"),
      cancelled("c1"),
      user("next"),
    ],
    repairs: ["added-cancelled-tool-result"],
  },
  {
    name: "5b. trailing call with no result",
    input: [user("hi"), assistant("", [call("c1", "read")])],
    expected: [
      user("hi"),
      assistant("", [call("c1", "read")]),
      cancelled("c1"),
    ],
    repairs: ["added-cancelled-tool-result"],
  },
  {
    name: "6. two user turns in a row are left alone by default",
    input: [user("a"), user("b")],
    expected: [user("a"), user("b")],
    repairs: [],
  },
  {
    name: "6. two user turns in a row are merged when alternation is required",
    input: [user("a"), user("b"), assistant("c"), assistant("d")],
    expected: [user("a\n\nb"), assistant("c\n\nd")],
    repairs: ["merged-same-role", "merged-same-role"],
    requiresAlternation: true,
  },
  {
    name: "6. merging a string and an array user turn",
    input: [
      user("look"),
      user([
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
      ]),
    ],
    expected: [
      user([
        { type: "text", text: "look" },
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
      ]),
    ],
    repairs: ["merged-same-role"],
    requiresAlternation: true,
  },
  {
    name: "7. history starts with assistant: left alone by default",
    input: [assistant("hello"), user("hi")],
    expected: [assistant("hello"), user("hi")],
    repairs: [],
  },
  {
    name: "7. history starts with assistant: a user turn first when alternation is required",
    input: [assistant("hello"), user("hi")],
    expected: [user("."), assistant("hello"), user("hi")],
    repairs: ["added-leading-user"],
    requiresAlternation: true,
  },
  {
    name: "8. user message with only an image is kept",
    input: [
      user([
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
      ]),
    ],
    expected: [
      user([
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
      ]),
    ],
    repairs: [],
  },
  {
    name: "9. truncated tool arguments are left to the converters",
    input: [
      user("hi"),
      assistant("", [call("c1", "read", '{"path": "a')]),
      tool("c1", CANCELLED_TOOL_CALL_MESSAGE),
    ],
    expected: [
      user("hi"),
      assistant("", [call("c1", "read", '{"path": "a')]),
      tool("c1", CANCELLED_TOOL_CALL_MESSAGE),
    ],
    repairs: [],
  },
  {
    name: "GUI: [user, assistant '', thinking, user] after Stop during reasoning",
    input: [user("q"), assistant(""), thinking("reasoning"), user("q2")],
    expected: [user("q"), user("q2")],
    repairs: ["dropped-empty-assistant", "dropped-orphan-thinking"],
  },
  {
    name: "GUI: redacted-thinking tail (Bedrock Nova)",
    input: [
      user("q"),
      assistant(""),
      {
        role: "thinking",
        content: "internal reasoning is hidden due to safety reasons",
        redactedThinking: "blob",
      },
      user("q2"),
    ],
    expected: [user("q"), user("q2")],
    repairs: ["dropped-empty-assistant", "dropped-orphan-thinking"],
  },
  {
    name: "GUI: a pruned middle leaves results with no call",
    input: [tool("c1", "old"), tool("c2", "older"), user("q")],
    expected: [
      user("Tool call output for Tool Call ID c1:\n\nold"),
      user("Tool call output for Tool Call ID c2:\n\nolder"),
      user("q"),
    ],
    repairs: ["orphan-tool-result-to-text", "orphan-tool-result-to-text"],
  },
  {
    name: "steering text between a call and its result moves after the results",
    input: [
      user("q"),
      assistant("", [call("c1", "read"), call("c2", "read")]),
      tool("c1"),
      user("leave b.ts alone"),
      tool("c2"),
    ],
    expected: [
      user("q"),
      assistant("", [call("c1", "read"), call("c2", "read")]),
      tool("c1"),
      tool("c2"),
      user("leave b.ts alone"),
    ],
    repairs: ["moved-user-after-tool-results"],
  },
  {
    name: "CLI: an aborted reply leaves two user turns, merged for strict templates",
    input: [user("q"), user("q again")],
    expected: [user("q\n\nq again")],
    repairs: ["merged-same-role"],
    requiresAlternation: true,
  },
];

/** Valid histories that every provider accepts: normalizeTurns leaves them. */
export const validHistories: Record<string, ChatMessage[]> = {
  "plain chat": [user("hi"), assistant("hello"), user("how are you?")],
  "tool loop": [
    user("read a.ts"),
    assistant("", [call("c1", "read_file", '{"path":"a.ts"}')]),
    tool("c1", "export const a = 1;"),
    assistant("It exports a.", [call("c2", "read_file", '{"path":"b.ts"}')]),
    tool("c2", "export const b = 2;"),
    assistant("Done."),
    user("thanks"),
  ],
  "parallel calls": [
    user("read both"),
    assistant("", [
      call("c1", "read_file", '{"path":"a.ts"}'),
      call("c2", "read_file", '{"path":"b.ts"}'),
    ]),
    tool("c1", "a"),
    tool("c2", "b"),
    user("now c"),
  ],
  "signed thinking with a call": [
    user("q"),
    thinking("I should read it", "sig-1"),
    assistant("", [call("c1", "read_file", '{"path":"a.ts"}')]),
    tool("c1", "a"),
    thinking("now answer", "sig-2"),
    assistant("a is 1"),
    user("ok"),
  ],
  images: [
    user([
      { type: "text", text: "what is this" },
      { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
    ]),
    assistant("a cat"),
    user("thanks"),
  ],
  "resumed session with a cancelled call": [
    user("delete x"),
    assistant("", [call("c1", "delete_file", '{"path":"x"}')]),
    tool("c1", CANCELLED_TOOL_CALL_MESSAGE),
    user("never mind"),
    assistant("OK."),
    user("continue"),
  ],
  "steering after the results": [
    user("q"),
    assistant("", [call("c1", "read")]),
    tool("c1"),
    user("also look at b"),
  ],
};
