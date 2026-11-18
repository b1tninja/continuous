import type { ChatHistoryItem, Session } from "core";
import { readFileTool } from "core/tools/definitions/readFile";
import { taskListTool } from "core/tools/definitions/taskList";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import type { CacheLedgerEntry } from "../../util/cacheLedger";
import { EMPTY_CONFIG, updateConfig } from "../slices/configSlice";
import { newSession, setPromptCacheState } from "../slices/sessionSlice";
import { setPolicyLevel } from "../slices/uiSlice";
import { setupStore } from "../store";

/**
 * A session for the fork tests: two turns in Agent mode on Claude Opus 5.5
 * (an attachment, reasoning and a tool call in the first), a task plan, a plan
 * file, a loop request, checkpoints and usage, with the ledger of the three
 * requests that wrote it, a warm cache and IDGAF set for tools.
 */
export const opus = {
  title: "Claude Opus 5.5",
  provider: "anthropic",
  model: "claude-opus-5-5",
  underlyingProviderName: "anthropic",
} as any;

export const history: ChatHistoryItem[] = [
  {
    message: { id: "m0", role: "user", content: "fix the parser" },
    contextItems: [
      {
        id: { providerTitle: "file", itemId: "a" },
        name: "parser.ts",
        description: "src/parser.ts",
        content: "export function parse() {}",
        uri: { type: "file", value: "file:///repo/src/parser.ts" },
      },
    ],
  },
  {
    message: {
      id: "m1",
      role: "assistant",
      content: "Reading it.",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
        },
      ],
    },
    contextItems: [],
    reasoning: { text: "Look first.", active: false, startAt: 1, endAt: 2 },
    toolCallStates: [
      {
        toolCallId: "call_1",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
        },
        status: "done",
        parsedArgs: { filepath: "a.ts" },
        output: [
          {
            name: "a.ts",
            description: "a.ts",
            content: "const a = 1;",
            uri: { type: "file", value: "file:///repo/a.ts" },
          },
        ],
      },
    ],
  },
  {
    message: { id: "m2", role: "assistant", content: "Fixed the parser." },
    contextItems: [],
  },
  {
    message: { id: "m3", role: "user", content: "now the tests" },
    contextItems: [],
  },
  {
    message: { id: "m4", role: "assistant", content: "Tests pass." },
    contextItems: [],
  },
] as any;

export const T0 = Date.now() - 100_000;
export const ledger: CacheLedgerEntry[] = [
  {
    at: T0,
    mode: "agent",
    provider: "anthropic",
    model: "claude-opus-5-5",
    cachingOn: true,
    ttl: "5m",
    oneHour: true,
    uncached: 0,
    read: 0,
    write5m: 60_000,
    write1h: 0,
    output: 500,
    historyItems: 1,
  },
  {
    at: T0 + 20_000,
    mode: "agent",
    provider: "anthropic",
    model: "claude-opus-5-5",
    cachingOn: true,
    ttl: "5m",
    oneHour: true,
    uncached: 0,
    read: 60_000,
    write5m: 1_000,
    write1h: 0,
    output: 300,
    historyItems: 2,
  },
  {
    at: T0 + 60_000,
    mode: "agent",
    provider: "anthropic",
    model: "claude-opus-5-5",
    cachingOn: true,
    ttl: "5m",
    oneHour: true,
    uncached: 0,
    read: 61_000,
    write5m: 1_000,
    write1h: 0,
    output: 200,
    historyItems: 4,
  },
];

export const parent: Session = {
  sessionId: "parent",
  title: "Fix the parser",
  workspaceDirectory: "",
  history,
  mode: "agent",
  chatModelTitle: opus.title,
  taskPlan: {
    items: [{ id: "1", text: "Fix the parser", status: "in_progress" }],
    updatedAt: "2026-11-13T00:00:00.000Z",
  },
  planFile: "file:///repo/.continuous/plans/parser.md",
  checkpoints: [{ turnId: "t1", files: [] } as any],
  loopRequested: true,
  usage: { totalCost: 3, promptTokens: 1, completionTokens: 1 },
};

/** The config and cache state of the fixture; again after a render's own loading. */
export function applyForkState(store: ReturnType<typeof setupStore>) {
  store.dispatch(
    updateConfig({
      ...EMPTY_CONFIG,
      tools: [readFileTool, taskListTool],
      selectedModelByRole: { ...EMPTY_CONFIG.selectedModelByRole, chat: opus },
      modelsByRole: { ...EMPTY_CONFIG.modelsByRole, chat: [opus] },
    }),
  );
  store.dispatch(
    setPromptCacheState({
      escalated: true,
      escalatedBy: "requests",
      lastRequestAt: T0 + 60_000,
      lastInputTokens: 62_000,
      lastTtl: "5m",
      requests: 7,
      ledger,
    }),
  );
}

export function setupForkStore() {
  const ideMessenger = new MockIdeMessenger();
  const saves: Session[] = [];
  ideMessenger.responseHandlers["history/save"] = async (s: any) => {
    saves.push(structuredClone(s));
    return undefined as any;
  };
  const store = setupStore({ ideMessenger });
  store.dispatch(newSession(structuredClone(parent)));
  applyForkState(store);
  store.dispatch(setPolicyLevel({ area: "tools", level: "idgaf" }));
  return { store, ideMessenger, saves };
}
