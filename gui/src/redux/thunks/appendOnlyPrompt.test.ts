/**
 * Every way the IDE sends a chat request, run over a long synthetic session,
 * with each request compared to the one before it: a local server (Strata,
 * llama.cpp) reuses only the longest prefix the two share, so a request whose
 * earlier messages differ from the previous request's re-reads the whole
 * conversation from that point. On 2026-11-15 a 400k-token session on Strata
 * re-read 384k tokens twice in twelve requests (docs: local servers, "Why a
 * turn re-reads the whole prompt").
 *
 * The real reducers and thunks build the requests; the store records what
 * `llm/compileChat` is asked to compile, which is what core sends. Each
 * request is turned into the OpenAI body core sends (toChatBody) and rendered
 * with the server's Qwen chat template, and the property checked is that the
 * previous request's prompt, minus its generation prompt, is a prefix of the
 * next one, apart from the rebuilds that are intended (a mode switch, Choose
 * what to keep, compaction).
 */
import { JSONContent } from "@tiptap/core";
import {
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  ModelDescription,
  RuleWithSource,
  ToolCallState,
} from "core";
import { toChatBody } from "core/llm/openaiTypeConverters";
import { getBaseToolDefinitions, serializeTool } from "core/tools";
import { BuiltInToolNames } from "core/tools/builtIn";
import { renderChatMessage } from "core/util/messageContent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendToolboxText } from "../../components/mainInput/Toolbox/toolboxActions";
import {
  firstDifference,
  renderQwenPrompt,
  withoutGenerationPrompt,
} from "../../util/test/qwenChatTemplate";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { updateConfig } from "../slices/configSlice";
import {
  clearDanglingMessages,
  enqueueMessage,
  setMode,
} from "../slices/sessionSlice";
import { RootState } from "../store";
import { findResumableTurn } from "../../util/resumeTurn";
import { resumeTurn } from "./resumeTurn";
import { retryFailedRequest } from "./retryFailedRequest";
import { streamResponseThunk } from "./streamResponse";

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({ resolveEditorContent: vi.fn() }),
);
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";

const STRATA: ModelDescription = {
  title: "Strata Qwen",
  model: "qwen3.8-flash-next-nvfp4-uncensored",
  provider: "openai",
  underlyingProviderName: "openai",
  apiBase: "http://127.0.0.1:8086/v1/",
  contextLength: 524_288,
  // What the local-server setup reads from /props chat_template_caps
  capabilities: { tools: true },
};

const TOOLS = getBaseToolDefinitions().map(serializeTool);
const READ = BuiltInToolNames.ReadFile;

function doc(text: string): JSONContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function textOf(editorState: JSONContent | undefined): string {
  const walk = (n: any): string =>
    n?.text ?? (n?.content ?? []).map(walk).join("");
  return walk(editorState);
}

function fileItem(name: string, content: string): ContextItemWithId {
  return {
    name,
    description: `src/${name}`,
    content,
    uri: { type: "file", value: `file:///repo/src/${name}` },
    id: { providerTitle: "file", itemId: name },
  };
}

/** `bytes` of plausible tool output, the same on every run. */
function output(seq: number, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `src/module${seq}/file${i}.ts:${i + 1}: const v${seq}_${i} = f(${i});`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

let callSeq = 0;
function toolCallState(name: string, args: object, out: string): ToolCallState {
  const id = `call-${++callSeq}`;
  return {
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    status: "done",
    parsedArgs: args,
    output: [{ name: "Result", description: name, content: out }],
  } as ToolCallState;
}

/**
 * A finished session of `turns` turns: a user message (every third with the
 * same file attached again), reasoning, two tool rounds and an answer.
 */
function longHistory(turns: number): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];
  let id = 0;
  const item = (message: ChatMessage, extra: Partial<ChatHistoryItem> = {}) =>
    history.push({
      message: { ...message, id: `h${++id}` } as unknown as ChatMessage,
      contextItems: [],
      ...extra,
    });
  for (let t = 0; t < turns; t++) {
    const text = `Turn ${t}: look at the lexer and fix what is wrong.`;
    item(
      { role: "user", content: text },
      {
        editorState: doc(text),
        contextItems:
          t % 3 === 0 ? [fileItem("lexer.ts", output(900, 3000))] : [],
      },
    );
    for (let r = 0; r < 2; r++) {
      item({ role: "thinking", content: `Thinking about step ${r}.` });
      const state = toolCallState(
        r === 0 ? READ : BuiltInToolNames.GrepSearch,
        { filepath: `src/f${t}_${r}.ts` },
        output(t * 10 + r, 2000),
      );
      item(
        {
          role: "assistant",
          content: "",
          toolCalls: [state.toolCall],
        },
        { toolCallStates: [state] },
      );
    }
    item({ role: "thinking", content: "Done." });
    item({ role: "assistant", content: `Fixed turn ${t}.` });
  }
  return history;
}

interface Sent {
  label: string;
  messages: ChatMessage[];
  options: any;
}

type Reply = ChatMessage[][] | Error;

function setup(
  opts: {
    history?: ChatHistoryItem[];
    rules?: RuleWithSource[];
    model?: ModelDescription;
  } = {},
) {
  const state = getEmptyRootState();
  state.session.id = "s1";
  state.session.mode = "agent";
  state.session.history = (opts.history ??
    longHistory(12)) as RootState["session"]["history"];
  state.config.config = {
    ...state.config.config,
    tools: TOOLS,
    rules: opts.rules ?? [],
    selectedModelByRole: {
      ...state.config.config.selectedModelByRole,
      chat: opts.model ?? STRATA,
    },
  };
  state.ui.toolSettings = Object.fromEntries(
    TOOLS.map((t) => [t.function.name, "allowedWithoutPermission"]),
  );
  const store = createMockStore(state);
  const messenger = store.mockIdeMessenger;
  const sent: Sent[] = [];
  let label = "";
  messenger.responseHandlers["llm/compileChat"] = async (data: any) => {
    sent.push({ label, messages: data.messages, options: data.options });
    return {
      compiledChatMessages: data.messages,
      didPrune: false,
      didAge: false,
      contextPercentage: 0.5,
      outputTokensAvailable: 8000,
    };
  };
  messenger.responses["tools/call"] = {
    contextItems: [
      { name: "Result", description: "tool", content: output(777, 1500) },
    ],
    errorMessage: undefined,
  };
  const replies: Reply[] = [];
  messenger.llmStreamChat = vi.fn(async function* () {
    const reply = replies.shift() ?? [[{ role: "assistant", content: "OK." }]];
    if (reply instanceof Error) throw reply;
    for (const chunk of reply) yield chunk as any;
    return undefined;
  }) as any;
  return {
    store,
    sent,
    replies,
    getState: () => store.getState() as RootState,
    /** Runs `fn` with the requests it sends labelled `name`. */
    async step(name: string, fn: () => Promise<unknown>) {
      label = name;
      await fn();
    },
  };
}

beforeEach(() => {
  vi.mocked(resolveEditorContent).mockImplementation(
    async ({ editorState }: any) => ({
      selectedContextItems: nextContext.splice(0),
      selectedCode: [],
      content: [{ type: "text", text: textOf(editorState) }],
      legacyCommandWithInput: undefined,
    }),
  );
});
let nextContext: ContextItemWithId[] = [];

/** The body core sends for a request: toChatBody, as OpenAI.ts builds it. */
function wire(s: Sent) {
  const options = s.options ?? {};
  const body = toChatBody(s.messages, {
    model: STRATA.model,
    ...options,
  });
  return {
    ...body,
    ...(options.reasoning === false && {
      chat_template_kwargs: { enable_thinking: false },
    }),
  };
}

interface Divergence {
  from: string;
  to: string;
  /** Where the next request first differs: a segment and a message index. */
  segment: "tools" | "system" | "message" | "options" | "none";
  index?: number;
  /** Characters of the rendered prompt the two share. */
  sharedChars: number;
  previousChars: number;
}

/** Compares each request with the one before it. */
function divergences(sent: Sent[]): Divergence[] {
  const out: Divergence[] = [];
  for (let i = 1; i < sent.length; i++) {
    const a = wire(sent[i - 1]);
    const b = wire(sent[i]);
    const prev = withoutGenerationPrompt(renderQwenPrompt(a as any));
    const next = renderQwenPrompt(b as any);
    const shared = firstDifference(prev, next);
    let segment: Divergence["segment"] = "none";
    let index: number | undefined;
    if (JSON.stringify(a.tools) !== JSON.stringify(b.tools)) segment = "tools";
    else if (
      JSON.stringify(a.messages[0]) !== JSON.stringify(b.messages[0]) &&
      a.messages[0]?.role === "system"
    )
      segment = "system";
    else {
      // The previous request's own trailing task list is not part of the
      // conversation: the next request may move it
      const n = a.messages.length;
      for (let m = 0; m < n; m++) {
        if (JSON.stringify(a.messages[m]) !== JSON.stringify(b.messages[m])) {
          segment = "message";
          index = m;
          break;
        }
      }
      if (
        segment === "none" &&
        (a as any).chat_template_kwargs?.enable_thinking !==
          (b as any).chat_template_kwargs?.enable_thinking
      ) {
        segment = "options";
      }
    }
    out.push({
      from: sent[i - 1].label,
      to: sent[i].label,
      segment,
      index,
      sharedChars: shared,
      previousChars: prev.length,
    });
  }
  return out;
}

const toolCallReply = (name: string, args: object): ChatMessage[][] => [
  [{ role: "thinking", content: "I will look." } as ChatMessage],
  [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `live-${++callSeq}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  ],
];

const RULES: RuleWithSource[] = [
  {
    name: "always",
    rule: "Always answer in British English.",
    source: "rules-block" as any,
    alwaysApply: true,
  },
  {
    name: "parser-rules",
    rule: "In the parser, keep every function pure and document its grammar rule.",
    source: "rules-block" as any,
    globs: "**/parser.ts",
  },
];

function send(s: ReturnType<typeof setup>, text: string) {
  return s.store.dispatch(
    streamResponseThunk({
      editorState: doc(text),
      modifiers: { useCodebase: false, noContext: false },
    }) as any,
  );
}

/** The comparisons that are not an extension of the previous request. */
function broken(sent: Sent[]): Divergence[] {
  return divergences(sent).filter(
    (d) => d.segment !== "none" || d.sharedChars !== d.previousChars,
  );
}

describe("every request path extends the previous request's prompt", () => {
  it("send, tool calls, attachments again, resume and toolbox cards", async () => {
    const s = setup();

    // A normal send that ends in an answer
    s.replies.push([[{ role: "assistant", content: "Sure." }]]);
    await s.step("send", () => send(s, "Please continue."));

    // A send whose answer calls a tool, and the continuation after it
    s.replies.push(toolCallReply(READ, { filepath: "src/a.ts" }));
    s.replies.push([[{ role: "assistant", content: "Read it." }]]);
    await s.step("send+tool", () => send(s, "Read a.ts."));

    // The same file attached again (sent as a stub), then a changed version
    nextContext = [fileItem("lexer.ts", output(900, 3000))];
    await s.step("re-attach", () => send(s, "Again with the lexer."));
    nextContext = [fileItem("lexer.ts", output(901, 3000))];
    await s.step("attach-changed", () => send(s, "The lexer changed."));

    // Resume after Stop mid-answer
    s.replies.push([[{ role: "assistant", content: "Partial" }]]);
    await s.step("stopped", () => send(s, "Write a long answer."));
    s.store.dispatch(clearDanglingMessages("stopped"));
    await s.step("resume", () => s.store.dispatch(resumeTurn() as any));

    // A toolbox card's text sent as the next message
    await s.step("toolbox", () =>
      sendToolboxText(s.store.dispatch as any, "Run the tests."),
    );

    expect(s.sent.map((r) => r.label)).toEqual([
      "send",
      "send+tool",
      "send+tool",
      "re-attach",
      "attach-changed",
      "stopped",
      "resume",
      "toolbox",
    ]);
    expect(broken(s.sent)).toEqual([]);
  });

  it("a nudge after a tool call written as text, and a message steered in after a tool", async () => {
    const s = setup();
    // A reply that writes the call as text: the nudge goes in as a user
    // message and the turn goes on
    s.replies.push([
      [
        {
          role: "assistant",
          content: `<tool_call>\n<function=${READ}>\n<parameter=filepath>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>`,
        },
      ],
    ]);
    s.replies.push([[{ role: "assistant", content: "Sorry." }]]);
    await s.step("nudge", () => send(s, "Read a.ts."));

    // "Send now" while a tool runs: the message goes in after the result
    s.replies.push(toolCallReply(READ, { filepath: "src/lexer.ts" }));
    s.replies.push([[{ role: "assistant", content: "Found it." }]]);
    const steer = vi.fn(async () => ({
      contextItems: [{ name: "Result", description: "grep", content: "hit" }],
      errorMessage: undefined,
    }));
    s.store.mockIdeMessenger.responseHandlers["tools/call"] = async () => {
      s.store.dispatch(
        enqueueMessage({
          editorState: doc("Also check the parser."),
          modifiers: { useCodebase: false, noContext: true },
          steer: true,
        }),
      );
      return steer();
    };
    await s.step("steer", () => send(s, "Search for the lexer."));

    expect(s.sent.map((r) => r.label)).toEqual([
      "nudge",
      "nudge",
      "steer",
      "steer",
    ]);
    expect(broken(s.sent)).toEqual([]);
  });

  it("a mode switch is the one rebuild here, and it changes only the system message and tools", async () => {
    const s = setup();
    await s.step("agent", () => send(s, "Plan the parser."));
    s.store.dispatch(setMode("plan"));
    await s.step("plan", () => send(s, "Now plan it."));
    const [d] = divergences(s.sent);
    expect(["system", "tools"]).toContain(d.segment);
  });

  it("a tool result that matches a scoped rule does not rewrite the system message", async () => {
    const s = setup({ rules: RULES });
    s.store.mockIdeMessenger.responses["tools/call"] = {
      contextItems: [
        {
          name: "parser.ts",
          description: "src/parser.ts",
          content: output(555, 1500),
          uri: { type: "file", value: "file:///repo/src/parser.ts" },
        },
      ],
      errorMessage: undefined,
    };
    s.replies.push(toolCallReply(READ, { filepath: "src/parser.ts" }));
    s.replies.push([[{ role: "assistant", content: "Read it." }]]);
    await s.step("send+tool", () => send(s, "Read the parser."));
    await s.step("send", () => send(s, "Now fix it."));

    expect(s.sent).toHaveLength(3);
    expect(broken(s.sent)).toEqual([]);
    // The rule is still sent: with the tool result that matched it
    const last = wire(s.sent[2]);
    const withRule = last.messages.filter((m: any) =>
      JSON.stringify(m.content).includes("keep every function pure"),
    );
    expect(withRule.map((m: any) => m.role)).toEqual(["tool"]);
    expect(JSON.stringify(last.messages[0].content)).not.toContain(
      "keep every function pure",
    );
  });

  it("the rule order does not follow the order a config reload lists the rules in", async () => {
    // Two rules scoped to the same file, and a global one: the first message
    // matches all three, so all three are in the system message
    const scoped: RuleWithSource[] = [
      {
        name: "lexer-style",
        rule: "Name every token kind in upper case.",
        source: "colocated-markdown" as any,
        sourceFile: "file:///repo/src/rules.md",
        globs: "**/lexer.ts",
      },
      {
        name: "lexer-tests",
        rule: "Give every token kind its own test case.",
        source: "colocated-markdown" as any,
        sourceFile: "file:///repo/.continuous/rules/lexer-tests.md",
        globs: "**/lexer.ts",
      },
    ];
    const s = setup({ rules: [RULES[0], ...scoped] });
    await s.step("send", () => send(s, "Look at the lexer."));
    // A reload lists the same rules in another order (a rules.md that
    // changed goes to the end until the next full scan)
    const config = s.getState().config.config;
    for (const rules of [
      [scoped[1], RULES[0], scoped[0]],
      [scoped[0], scoped[1], RULES[0]],
    ]) {
      s.store.dispatch(updateConfig({ ...config, rules }));
      await s.step("after-reload", () => send(s, "Go on."));
    }
    expect(s.sent).toHaveLength(3);
    const system = JSON.stringify(wire(s.sent[0]).messages[0].content);
    expect(system).toContain("upper case");
    expect(system).toContain("own test case");
    expect(broken(s.sent)).toEqual([]);
  });

  it("after a compaction, the next requests extend the first request after it", async () => {
    // What loadSession brings back after "Compact": the summary on the item
    // the compaction ran at; only the items after it are sent
    const history = longHistory(12);
    const at = history.length - 1;
    history[at] = {
      ...history[at],
      conversationSummary: "The lexer was fixed in twelve turns.",
    };
    const s = setup({ history, rules: RULES });
    await s.step("after-compaction", () => send(s, "Now the parser."));
    s.replies.push(toolCallReply(READ, { filepath: "src/parser.ts" }));
    s.replies.push([[{ role: "assistant", content: "Read it." }]]);
    await s.step("next", () => send(s, "Read the parser."));
    await s.step("next", () => send(s, "And fix it."));

    expect(s.sent).toHaveLength(4);
    const first = wire(s.sent[0]);
    // The summary is the first message after the system message (C104)
    expect(JSON.stringify(first.messages[0].content)).not.toContain(
      "Previous conversation summary",
    );
    expect(first.messages[1].content).toBe(
      "Previous conversation summary:\n\nThe lexer was fixed in twelve turns.",
    );
    // Only the new message is sent after the summary
    expect(first.messages.map((m: any) => m.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(broken(s.sent)).toEqual([]);
  });

  it("Try again right after a compaction sends the same request", async () => {
    const history = longHistory(12);
    const at = history.length - 1;
    history[at] = {
      ...history[at],
      conversationSummary: "The lexer was fixed in twelve turns.",
    };
    const s = setup({ history, rules: RULES });
    s.replies.push(new Error("Request timed out."));
    await s.step("after-compaction", () => send(s, "Now the parser."));
    const input = s.getState().session.mainEditorContentTrigger;
    await s.step("try-again", () =>
      s.store.dispatch(retryFailedRequest({ input }) as any),
    );
    s.replies.push(toolCallReply(READ, { filepath: "src/parser.ts" }));
    s.replies.push(new Error("Request timed out."));
    await s.step("tool", () => send(s, "Read the parser."));
    await s.step("try-again", () =>
      s.store.dispatch(retryFailedRequest({}) as any),
    );

    const [failed, retry] = s.sent;
    expect(wire(retry).messages).toEqual(wire(failed).messages);
    const failedContinuation = s.sent[3];
    const retriedContinuation = s.sent[4];
    expect(retriedContinuation.label).toBe("try-again");
    expect(wire(retriedContinuation).messages).toEqual(
      wire(failedContinuation).messages,
    );
    expect(broken(s.sent)).toEqual([]);
  });

  it("Try again after a failed continuation sends the same request, with the tool result", async () => {
    const s = setup();
    s.replies.push(toolCallReply(READ, { filepath: "src/a.ts" }));
    s.replies.push(new Error("Request timed out."));
    await s.step("send+tool", () => send(s, "Read a.ts."));
    expect(s.getState().session.history.at(-1)?.message.role).toBe("tool");

    s.replies.push([[{ role: "assistant", content: "Read it." }]]);
    await s.step("try-again", () =>
      s.store.dispatch(retryFailedRequest({}) as any),
    );

    const [, failed, retry] = s.sent;
    expect(retry.label).toBe("try-again");
    expect(wire(retry).messages).toEqual(wire(failed).messages);
    expect(broken(s.sent)).toEqual([]);
    expect(findResumableTurn(s.getState().session.history)).toBeUndefined();
  });

  it("Try again after a failed new message sends it again from the input, at the end", async () => {
    const s = setup();
    s.replies.push(new Error("Request timed out."));
    await s.step("send", () => send(s, "This one fails."));
    // The failed message went back to the input
    const input = s.getState().session.mainEditorContentTrigger;
    expect(textOf(input)).toBe("This one fails.");

    await s.step("try-again", () =>
      s.store.dispatch(retryFailedRequest({ input }) as any),
    );

    const [failed, retry] = s.sent;
    expect(wire(retry).messages).toEqual(wire(failed).messages);
    expect(broken(s.sent)).toEqual([]);
  });
});

/** Each turn of longHistory is seven items; its answer is at 7t + 6. */
const endOfTurn = (t: number) => 7 * t + 6;

/** `history` as loadSession brings it back after "Compact" ran at `at`. */
function compacted(
  history: ChatHistoryItem[],
  at = endOfTurn(9),
  opts: { recordLength?: boolean } = {},
): ChatHistoryItem[] {
  const out = [...history];
  out[at] = {
    ...out[at],
    conversationSummary: "Turns 0 to 9 fixed the lexer.",
    ...(opts.recordLength !== false && {
      conversationSummaryHistoryLength: history.length,
    }),
  };
  return out;
}

const LEXER_RULE: RuleWithSource = {
  name: "lexer-style",
  rule: "Name every token kind in upper case.",
  source: "rules-block" as any,
  globs: "**/lexer.ts",
};
const TEST_RULE: RuleWithSource = {
  name: "test-style",
  rule: "Give every test a name that says what it checks.",
  source: "rules-block" as any,
  globs: "**/test.ts",
};
/** Always; the first message's file; a summarised turn's file; a kept turn's file. */
const COMPACTION_RULES = [TEST_RULE, RULES[1], LEXER_RULE, RULES[0]];

/**
 * Twelve turns where the first message attaches lexer.ts (its rule goes in
 * the system message), turn 4 attaches parser.ts and turn 10 test.ts (their
 * rules go with those messages).
 */
function ruledHistory(): ChatHistoryItem[] {
  const history = longHistory(12);
  const t4 = 7 * 4;
  const t10 = 7 * 10;
  history[t4] = {
    ...history[t4],
    contextItems: [fileItem("parser.ts", output(400, 1000))],
  };
  history[t10] = {
    ...history[t10],
    contextItems: [fileItem("test.ts", output(401, 500))],
  };
  return history;
}

const OPUS: ModelDescription = {
  title: "Claude Opus 5.5",
  model: "claude-opus-5-5",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  contextLength: 1_000_000,
  capabilities: { tools: true },
};

const has = (m: any, text: string) => JSON.stringify(m.content).includes(text);

describe("a compaction keeps the head: the summary goes after the system message (C104)", () => {
  async function beforeAndAfter(
    rules = COMPACTION_RULES,
    history = ruledHistory(),
  ) {
    const before = setup({ history, rules });
    await before.step("before", () => send(before, "Next."));
    const after = setup({ history: compacted(history), rules });
    await after.step("after", () => send(after, "Next."));
    return { pre: wire(before.sent[0]), post: wire(after.sent[0]) };
  }

  it("the tools and the system message are the same bytes before and after a compaction", async () => {
    const { pre, post } = await beforeAndAfter();

    // The golden: the system message and the tools, byte for byte
    expect(post.messages[0].role).toBe("system");
    expect(JSON.stringify(post.messages[0])).toBe(
      JSON.stringify(pre.messages[0]),
    );
    expect(JSON.stringify(post.tools)).toBe(JSON.stringify(pre.tools));
    // and as the server renders them: the two prompts share everything up
    // to the end of the system turn, tools included, so that cache survives
    const preText = renderQwenPrompt(pre as any);
    const postText = renderQwenPrompt(post as any);
    const systemEnd = preText.indexOf("<|im_end|>");
    expect(systemEnd).toBeGreaterThan(0);
    expect(firstDifference(preText, postText)).toBeGreaterThan(systemEnd);

    // The rules that always apply and the first message's are in it
    expect(has(post.messages[0], "British English")).toBe(true);
    expect(has(post.messages[0], "upper case")).toBe(true);
    expect(has(post.messages[0], "keep every function pure")).toBe(false);
    expect(has(post.messages[0], "Previous conversation summary")).toBe(false);
  });

  it("a rule a summarised message matched goes with the summary; a kept message keeps its own", async () => {
    const { pre, post } = await beforeAndAfter();

    const summary = post.messages[1];
    expect(summary.role).toBe("user");
    expect(summary.content).toBe(
      'Previous conversation summary:\n\nTurns 0 to 9 fixed the lexer.\n\n<rule name="parser-rules">\nIn the parser, keep every function pure and document its grammar rule.\n</rule>',
    );
    // The kept turns are sent as they were before the compaction, turn 10's
    // message with its test.ts rule included
    const kept = post.messages.slice(2);
    expect(kept).toEqual(pre.messages.slice(-kept.length));
    const withTestRule = kept.filter((m: any) => has(m, "what it checks"));
    expect(withTestRule.map((m: any) => m.role)).toEqual(["user"]);
    // Every rule is sent exactly once
    for (const text of [
      "British English",
      "token kind in upper case",
      "keep every function pure",
      "says what it checks",
    ]) {
      expect(post.messages.filter((m: any) => has(m, text))).toHaveLength(1);
    }
  });

  it("the rules keep their fixed order after a compaction", async () => {
    const history = ruledHistory();
    const { post } = await beforeAndAfter(COMPACTION_RULES, history);
    const { post: reordered } = await beforeAndAfter(
      [...COMPACTION_RULES].reverse(),
      history,
    );
    expect(reordered.messages).toEqual(post.messages);
  });

  it("after a compaction that kept turns, every request extends the one before", async () => {
    const s = setup({
      history: compacted(ruledHistory()),
      rules: COMPACTION_RULES,
    });
    await s.step("after-compaction", () => send(s, "Now the parser."));
    s.replies.push(toolCallReply(READ, { filepath: "src/parser.ts" }));
    s.replies.push([[{ role: "assistant", content: "Read it." }]]);
    await s.step("tool", () => send(s, "Read the parser."));
    await s.step("next", () => send(s, "And fix it."));
    expect(s.sent).toHaveLength(4);
    expect(broken(s.sent)).toEqual([]);
  });

  it("on a model with preserved thinking, reasoning from before the compaction is not sent again", async () => {
    // Turns 10 and 11 were kept, and their reasoning was minted with turns
    // 0 to 9 in front of it: sent back after the summary it fails the
    // prefix check (core/tools/toolListHold.ts thinkingCutAfterCompaction)
    const s = setup({ history: compacted(longHistory(12)), model: OPUS });
    s.replies.push(toolCallReply(READ, { filepath: "src/parser.ts" }));
    s.replies.push([[{ role: "assistant", content: "Read it." }]]);
    await s.step("after-compaction", () => send(s, "Read the parser."));
    await s.step("next", () => send(s, "And fix it."));

    const roles = (x: Sent) => x.messages.map((m) => m.role);
    expect(s.sent).toHaveLength(3);
    expect(roles(s.sent[0])).not.toContain("thinking");
    // The kept turns' tool calls and results are still sent
    expect(roles(s.sent[0]).filter((r) => r === "tool")).toHaveLength(4);
    // Reasoning minted after the compaction is sent again, as usual
    expect(roles(s.sent[1])).toContain("thinking");
    expect(roles(s.sent[2])).toContain("thinking");
    for (const sent of s.sent) {
      expect(renderChatMessage(sent.messages[1])).toContain(
        "Previous conversation summary:",
      );
    }
    expect(broken(s.sent)).toEqual([]);
  });

  it("a model without the prefix check keeps the kept turns' reasoning", async () => {
    const s = setup({ history: compacted(longHistory(12)) });
    await s.step("after-compaction", () => send(s, "Next."));
    expect(s.sent[0].messages.map((m) => m.role)).toContain("thinking");
  });

  it("a summary on a reasoning item is still sent on a preserved-thinking model", async () => {
    // endOfTurn(9) - 1 is turn 9's last reasoning item
    const s = setup({
      history: compacted(longHistory(12), endOfTurn(9) - 1),
      model: OPUS,
    });
    await s.step("after-compaction", () => send(s, "Next."));
    expect(renderChatMessage(s.sent[0].messages[1])).toContain(
      "Previous conversation summary:",
    );
    expect(s.sent[0].messages.filter((m) => has(m, "Turn 3:"))).toHaveLength(0);
  });
});
