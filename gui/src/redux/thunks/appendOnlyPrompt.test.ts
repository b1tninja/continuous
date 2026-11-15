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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendToolboxText } from "../../components/mainInput/Toolbox/toolboxActions";
import {
  firstDifference,
  renderQwenPrompt,
  withoutGenerationPrompt,
} from "../../util/test/qwenChatTemplate";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
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
  opts: { history?: ChatHistoryItem[]; rules?: RuleWithSource[] } = {},
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
      chat: STRATA,
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
