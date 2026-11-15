/**
 * Long-session guards (plans/research/prompt-logs-and-session-storage.md,
 * STOR2 and STOR3). A scripted model drives 500 agent requests through the
 * real reducers and thunks: 100 user turns of four tool rounds and a closing
 * answer each, tool results of 2 to 20 KB, and an image every tenth turn.
 * Every `history/save` the GUI sends is measured as the file core would write
 * (`serializeSession`, the serializer `HistoryManager.save` uses).
 *
 * The property that `promptLogs` broke: a session's file grows with its
 * length, not with the square of it. A session of a few turns cannot show the
 * difference, so these tests drive enough requests for a quadratic term to
 * dominate, and fail fast (at the size budget) instead of running a broken
 * build out of memory.
 */
import { JSONContent } from "@tiptap/core";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import {
  AssistantChatMessage,
  ChatHistoryItem,
  ChatMessage,
  InputModifiers,
  MessagePart,
  PromptLog,
  Session,
} from "core";
import { serializeTool } from "core/tools";
import { grepSearchTool } from "core/tools/definitions";
import { renderChatMessage } from "core/util/messageContent";
import { serializeSession } from "core/util/sessionFile";
import { configureStore } from "@reduxjs/toolkit";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { getEmptyRootState } from "../../util/test/mockStore";
import blockedCallsReducer from "../slices/blockedCallsSlice";
import configReducer from "../slices/configSlice";
import editModeStateReducer from "../slices/editState";
import indexingReducer from "../slices/indexingSlice";
import { profilesReducer } from "../slices/profilesSlice";
import sessionReducer from "../slices/sessionSlice";
import tabsReducer from "../slices/tabsSlice";
import uiReducer from "../slices/uiSlice";
import { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(),
  }),
);

import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";

const USER_TURNS = 100;
const ROUNDS_PER_TURN = 5; // four tool rounds, then the answer
const REQUESTS = USER_TURNS * ROUNDS_PER_TURN;
const CHECKPOINT_EVERY = 100; // requests

const MB = 1024 * 1024;
/**
 * No save may carry more than this. The session below is about 12 MB at 500
 * requests (about 25 KB per request); with every prompt kept it passes this
 * at request 95, so a regression fails here instead of exhausting the heap.
 */
const SAVE_BUDGET_BYTES = 40 * MB;
/** What one request may add to the file, on average (the fitted slope). */
const PER_REQUEST_BUDGET_BYTES = 64 * 1024;
/** Heap growth over the run: generous, as garbage may not be collected yet. */
const HEAP_BUDGET_BYTES = 256 * MB;

const grepTool = serializeTool(grepSearchTool);

/** Deterministic sizes: the same session on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `bytes` of plausible tool output (grep lines), a fresh string each call. */
function toolOutput(seq: number, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `src/module${seq % 97}/file${i}.ts:${i + 1}:  const value${seq}_${i} = compute(${i}, "${seq}");`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n").slice(0, bytes);
}

/** A data URL of about `bytes`, as a pasted screenshot would be. */
function imageDataUrl(seq: number, bytes: number): string {
  const body = `iVBORw0KGgo${seq}`
    .padEnd(64, "A")
    .repeat(Math.ceil(bytes / 64));
  return `data:image/png;base64,${body.slice(0, bytes)}`;
}

/** What core sends as `PromptLog.prompt`: every message rendered as text. */
function renderPrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => `<${m.role}>\n${renderChatMessage(m)}`)
    .join("\n\n");
}

const bytesOf = (value: unknown) =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");

interface Checkpoint {
  requests: number;
  fileBytes: number;
}

interface Run {
  checkpoints: Checkpoint[];
  saves: number;
  largestSave: number;
  heapDelta: number;
  elapsedMs: number;
  finalSession: Session;
  stoppedAt?: string;
}

/**
 * The real reducers, without the action recording of `createMockStore` (500
 * requests of actions would stay alive) and without the development-only
 * checks that walk the whole state on every action.
 */
function longSessionStore(messenger: MockIdeMessenger) {
  const state = getEmptyRootState();
  state.session.id = "long-session";
  state.config.config.selectedModelByRole.chat = {
    title: "Claude 3.5 Sonnet",
    model: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    underlyingProviderName: "anthropic",
    completionOptions: { promptCaching: false },
  };
  state.config.config.tools = [grepTool];
  state.ui.toolSettings = {
    [grepTool.function.name]: "allowedWithoutPermission",
  };
  return configureStore({
    reducer: {
      session: sessionReducer,
      ui: uiReducer,
      editModeState: editModeStateReducer,
      config: configReducer,
      indexing: indexingReducer,
      tabs: tabsReducer,
      profiles: profilesReducer,
      blockedCalls: blockedCallsReducer,
    },
    preloadedState: state,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
        immutableCheck: false,
        thunk: { extraArgument: { ideMessenger: messenger } },
      }),
  });
}

async function runLongSession(): Promise<Run> {
  const random = mulberry32(0x5e55);
  const messenger = new MockIdeMessenger();
  const store = longSessionStore(messenger);

  // Core compiles the messages as given (no pruning: a 1M-token window)
  messenger.responseHandlers["llm/compileChat"] = async (data) => ({
    compiledChatMessages: data.messages,
    didPrune: false,
    contextPercentage: 0.3,
  });

  let toolSeq = 0;
  messenger.responseHandlers["tools/call"] = async () => {
    toolSeq++;
    const bytes = Math.round(2048 + random() * (20 * 1024 - 2048));
    return {
      contextItems: [
        {
          name: "Search results",
          description: `grep ${toolSeq}`,
          content: toolOutput(toolSeq, bytes),
          icon: "search",
          hidden: false,
        },
      ],
      errorMessage: undefined,
    };
  };

  let lastSaved: Session | undefined;
  let lastSaveBytes = 0;
  let largestSave = 0;
  let saves = 0;
  let stoppedAt: string | undefined;
  messenger.responseHandlers["history/save"] = async (session) => {
    saves++;
    lastSaved = session;
    // Unindented is what crosses the webview boundary; the file is indented,
    // measured at the checkpoints below
    lastSaveBytes = Buffer.byteLength(JSON.stringify(session), "utf8");
    largestSave = Math.max(largestSave, lastSaveBytes);
    if (lastSaveBytes > SAVE_BUDGET_BYTES && !stoppedAt) {
      stoppedAt = `save ${saves} carried ${(lastSaveBytes / MB).toFixed(1)} MB at request ${requests}`;
    }
    return undefined;
  };

  // The scripted model: tool calls for the first rounds of a turn, then an
  // answer. The prompt log carries the whole prompt, as core's does.
  let requests = 0;
  messenger.llmStreamChat = async function* (msg, signal) {
    requests++;
    const round = (requests - 1) % ROUNDS_PER_TURN;
    const text = `Round ${round} of request ${requests}. `.repeat(
      8 + Math.floor(random() * 40),
    );
    yield [{ role: "assistant", content: text }];
    if (round < ROUNDS_PER_TURN - 1 && !signal.aborted) {
      const toolCall: AssistantChatMessage = {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call-${requests}`,
            type: "function",
            function: {
              name: grepTool.function.name,
              arguments: JSON.stringify({ query: `symbol${requests}` }),
            },
          },
        ],
      };
      yield [toolCall];
    }
    const log: PromptLog = {
      modelTitle: "Claude 3.5 Sonnet",
      modelProvider: "anthropic",
      prompt: renderPrompt(msg.messages as ChatMessage[]),
      completion: text,
    };
    return log;
  } as typeof messenger.llmStreamChat;

  const modifiers: InputModifiers = { useCodebase: false, noContext: true };
  const checkpoints: Checkpoint[] = [];
  const gc = collector();
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = Date.now();

  for (let turn = 0; turn < USER_TURNS && !stoppedAt; turn++) {
    const ask = `Turn ${turn}: find where symbol${turn} is used and fix the callers.`;
    const image = turn % 10 === 9 ? imageDataUrl(turn, 60 * 1024) : undefined;
    const content: MessagePart[] | string = image
      ? [
          { type: "text", text: ask },
          { type: "imageUrl", imageUrl: { url: image } },
        ]
      : ask;
    const editorState: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: ask }] },
        ...(image ? [{ type: "image", attrs: { src: image } }] : []),
      ],
    };
    vi.mocked(resolveEditorContent).mockResolvedValueOnce({
      selectedContextItems: [],
      selectedCode: [],
      content,
      legacyCommandWithInput: undefined,
    });
    await store.dispatch(streamResponseThunk({ editorState, modifiers }));

    if (requests % CHECKPOINT_EVERY === 0 && lastSaved) {
      checkpoints.push({
        requests,
        fileBytes: Buffer.byteLength(serializeSession(lastSaved), "utf8"),
      });
    }
  }

  const elapsedMs = Date.now() - started;
  gc();
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  const state = store.getState() as RootState;
  expect(state.session.isStreaming).toBe(false);

  return {
    checkpoints,
    saves,
    largestSave,
    heapDelta,
    elapsedMs,
    finalSession: lastSaved!,
    stoppedAt,
  };
}

/**
 * A full garbage collection, so the heap measured is what is still held and
 * not what has not been collected yet. `--expose-gc` cannot be passed to the
 * test worker from here, so the flag is set at run time and `gc` taken from a
 * fresh context, which V8 creates with the flag applied.
 */
function collector(): () => void {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (exposed) return exposed;
  v8.setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

/** Least-squares fit of y = a + b x (+ c x^2 when `quadratic`). */
function fit(points: { x: number; y: number }[], quadratic: boolean) {
  const rows = points.map((p) => (quadratic ? [1, p.x, p.x * p.x] : [1, p.x]));
  const n = rows[0].length;
  // Normal equations, solved by Gaussian elimination: n is 2 or 3
  const a = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) =>
      rows.reduce(
        (sum, r, k) => sum + r[i] * (j === n ? points[k].y : r[j]),
        0,
      ),
    ),
  );
  for (let i = 0; i < n; i++) {
    for (let k = i + 1; k < n; k++) {
      const f = a[k][i] / a[i][i];
      for (let j = i; j <= n; j++) a[k][j] -= f * a[i][j];
    }
  }
  const coef = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = a[i][n];
    for (let j = i + 1; j < n; j++) s -= a[i][j] * coef[j];
    coef[i] = s / a[i][i];
  }
  return coef;
}

/**
 * How each history item field grows (STOR3). A new field on
 * `ChatHistoryItem` will not compile until it is listed here.
 *
 * - "bounded": its size does not depend on how long the session is.
 * - "newest": only the newest item may carry a large value, and only in
 *   memory (the newest request's prompt, kept for the feedback buttons; no
 *   prompt is saved, core/util/promptLogs.ts); older items hold a bounded
 *   remainder.
 * - "request-time": never saved.
 */
type GrowthClass = "bounded" | "newest" | "request-time";
const FIELD_GROWTH: Record<keyof ChatHistoryItem, GrowthClass> = {
  message: "bounded",
  contextItems: "bounded",
  editorState: "bounded",
  modifiers: "bounded",
  promptLogs: "newest",
  toolCallStates: "bounded",
  isGatheringContext: "bounded",
  reasoning: "bounded",
  appliedRules: "bounded",
  conversationSummary: "bounded",
  interrupted: "bounded",
  removedByUser: "bounded",
  cachePin: "request-time",
};

describe("a 500-request agent session (STOR2, STOR3)", () => {
  let run: Run;

  beforeAll(async () => {
    const log = console.log;
    const info = console.info;
    // Thunks log per request; 500 requests of it is noise
    console.log = () => {};
    console.info = () => {};
    try {
      run = await runLongSession();
    } finally {
      console.log = log;
      console.info = info;
    }
    // Straight to stdout: the numbers belong in the CI log of a passing run
    process.stdout.write(
      `long session: ${run.checkpoints.map((c) => `${c.requests} req ${(c.fileBytes / MB).toFixed(2)} MB`).join(", ")}; ` +
        `${run.saves} saves, largest ${(run.largestSave / MB).toFixed(2)} MB; heap +${(run.heapDelta / MB).toFixed(0)} MB; ${run.elapsedMs} ms` +
        (run.stoppedAt ? `; stopped: ${run.stoppedAt}` : "") +
        "\n",
    );
  }, 120_000);

  it("runs all 500 requests without a save past the budget", () => {
    expect(run.stoppedAt).toBeUndefined();
    expect(run.checkpoints.map((c) => c.requests)).toEqual([
      100, 200, 300, 400, 500,
    ]);
    expect(run.largestSave).toBeLessThanOrEqual(SAVE_BUDGET_BYTES);
  });

  it("grows the session file linearly, with a bounded cost per request", () => {
    expect(run.checkpoints.length).toBeGreaterThanOrEqual(3);
    const points = run.checkpoints.map((c) => ({
      x: c.requests,
      y: c.fileBytes,
    }));
    const [, slope] = fit(points, false);
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeLessThanOrEqual(PER_REQUEST_BUDGET_BYTES);

    // The quadratic term of the best fit accounts for little of the size at
    // 500 requests: with every prompt kept it accounts for most of it
    const [, , curvature] = fit(points, true);
    const last = points[points.length - 1];
    expect(Math.abs(curvature) * last.x * last.x).toBeLessThan(0.1 * last.y);

    // And the plain ratio: five times the requests, at most six times the size
    expect(last.y).toBeLessThanOrEqual(6 * points[0].y);
  });

  it("saves about once per request, never more than the session", () => {
    expect(run.saves).toBeLessThanOrEqual(2 * REQUESTS);
    const final = Buffer.byteLength(JSON.stringify(run.finalSession), "utf8");
    expect(run.largestSave).toBeLessThanOrEqual(final * 1.05);
  });

  it("keeps the heap growth under budget", () => {
    expect(run.heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);
  });

  it("has no history item field that grows with the request count", () => {
    const items = run.finalSession.history;
    const window = Math.floor(items.length / 10);
    const early = items.slice(0, window);
    const late = items.slice(items.length - 1 - window, items.length - 1);
    const newest = items[items.length - 1];

    const seen = new Set(items.flatMap((item) => Object.keys(item)));
    for (const key of seen) {
      // A field not listed above was added with `any`: list it with its class
      expect(Object.keys(FIELD_GROWTH)).toContain(key);
    }

    const mean = (list: ChatHistoryItem[], key: keyof ChatHistoryItem) =>
      list.reduce((sum, item) => sum + bytesOf(item[key]), 0) / list.length;
    const grew: string[] = [];
    for (const key of Object.keys(FIELD_GROWTH) as (keyof ChatHistoryItem)[]) {
      const cls = FIELD_GROWTH[key];
      if (cls === "request-time") {
        if (seen.has(key)) grew.push(`${key} is saved`);
        continue;
      }
      const before = mean(early, key);
      const after = mean(late, key);
      // Tool output sizes are random: allow the windows to differ by half,
      // plus 2 KB for small fields
      if (after > before * 1.5 + 2048) {
        grew.push(
          `${key}: ${Math.round(before)} bytes per item early, ${Math.round(after)} late`,
        );
      }
      if (cls === "bounded" && bytesOf(newest[key]) > 64 * 1024 + 2 * after) {
        grew.push(`${key} on the newest item: ${bytesOf(newest[key])} bytes`);
      }
    }
    expect(grew).toEqual([]);
  });
});
