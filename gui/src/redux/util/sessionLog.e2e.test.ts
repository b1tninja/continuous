/**
 * The webview's save path against the real core session log (STOR6/STOR7):
 * deltas, checkpoints during a turn and a crash in the middle of one, and
 * every reader of a session on one whose large outputs are blobs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ChatHistoryItem, Session } from "core";
import { forkSession } from "core/util/forkSession";
import { toMarkDown } from "core/util/historyUtils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IIdeMessenger } from "../../context/IdeMessenger";
import { findResumableTurn, markTurnCutOffOnLoad } from "../../util/resumeTurn";
import { historyTokens, listRemovable } from "../../util/selectiveCompaction";
import { constructMessages } from "./constructMessages";
import { resetSessionDeltaState, saveSessionToCore } from "./sessionDelta";

type HistoryModule = typeof import("core/util/history");
let HistoryManager: HistoryModule["HistoryManager"];
let blobDir: (id: string) => string;
let logFile: (id: string) => string;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-log-e2e-"));
  process.env.CONTINUE_GLOBAL_DIR = root;
  ({ HistoryManager } = await import("core/util/history"));
  const paths = await import("core/util/paths");
  blobDir = paths.getSessionBlobFolderPath;
  logFile = paths.getSessionLogFilePath;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => resetSessionDeltaState());

/** A messenger that hands saves to a core HistoryManager, as core.ts does. */
function coreMessenger(manager: InstanceType<typeof HistoryManager>) {
  const posted: { type: string; chars: number }[] = [];
  const messenger = {
    request: async (type: string, data: any) => {
      posted.push({ type, chars: JSON.stringify(data).length });
      if (type === "history/save") {
        return { status: "success", content: manager.save(data) };
      }
      if (type === "history/saveDelta") {
        return { status: "success", content: manager.saveDelta(data) };
      }
      throw new Error(type);
    },
  } as unknown as IIdeMessenger;
  return { messenger, posted };
}

function logManager() {
  const m = new HistoryManager();
  m.setSessionLog(true);
  return m;
}

function big(seed: string, chars = 20_000): string {
  let s = "";
  for (let i = 0; s.length < chars; i++) s += `${seed} ${i}\n`;
  return s;
}

const user = (text: string): ChatHistoryItem => ({
  message: { role: "user", content: text },
  contextItems: [],
  editorState: { type: "doc", content: [{ type: "paragraph" }] },
});
const assistant = (text: string): ChatHistoryItem => ({
  message: { role: "assistant", content: text },
  contextItems: [],
});

function toolCall(id: string, status: "generated" | "done", out?: string[]) {
  const call = {
    id,
    type: "function" as const,
    function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
  };
  const item: ChatHistoryItem = {
    message: { role: "assistant", content: "", toolCalls: [call] },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall: call,
        status,
        parsedArgs: { filepath: "a.ts" },
        ...(out && {
          output: out.map((content) => ({
            name: "a.ts",
            description: "file",
            content,
          })),
        }),
      },
    ],
  };
  return item;
}

const toolMessage = (id: string, out: string[]): ChatHistoryItem => ({
  message: { role: "tool", content: out.join("\n\n"), toolCallId: id },
  contextItems: [],
});

function session(id: string, history: ChatHistoryItem[]): Session {
  return { sessionId: id, title: "E2E", workspaceDirectory: "/ws", history };
}

/** What reopening the window does: read the file, mark a cut-off turn. */
function reopen(id: string): ChatHistoryItem[] {
  const history = new HistoryManager().load(id).history;
  markTurnCutOffOnLoad(history);
  return history;
}

describe("webview saves against the core session log", () => {
  it("posts only the change after the first save", async () => {
    const m = logManager();
    const { messenger, posted } = coreMessenger(m);
    let history: ChatHistoryItem[] = [user("q")];
    for (let i = 0; i < 20; i++) {
      history = [...history, assistant(big(`answer ${i}`, 3_000))];
      await saveSessionToCore(messenger, session("delta-1", history));
    }
    await m.flush();
    expect(posted[0].type).toBe("history/save");
    expect(posted.slice(1).every((p) => p.type === "history/saveDelta")).toBe(
      true,
    );
    // The last post is one item, not twenty
    expect(posted.at(-1)!.chars).toBeLessThan(posted.at(-2)!.chars * 1.2);
    expect(posted.at(-1)!.chars).toBeLessThan(5_000);
    expect(new HistoryManager().load("delta-1").history).toEqual(history);
  });

  it("a crash in the middle of a turn keeps the message, the tool results and the partial answer", async () => {
    const id = "crash-1";
    const m = logManager();
    const { messenger } = coreMessenger(m);
    const out = [big("contents of a.ts")];
    const done: ChatHistoryItem[] = [user("first question"), assistant("ok")];
    await saveSessionToCore(messenger, session(id, done));

    // The person sends a message: saved before the answer starts
    let history = [...done, user("read a.ts and fix it")];
    await saveSessionToCore(messenger, session(id, history), {
      checkpoint: "reloaded",
    });
    // The model calls a tool; it runs; its result is saved at the boundary
    history = [...history, toolCall("c1", "done", out), toolMessage("c1", out)];
    await saveSessionToCore(messenger, session(id, history), {
      checkpoint: "reloaded",
    });
    // The answer streams; a throttled checkpoint catches part of it
    history = [...history, assistant("The bug is in line")];
    await saveSessionToCore(messenger, session(id, history), {
      checkpoint: "reloaded",
    });
    await m.flush();
    // ...and the window dies while the next write is half done
    fs.appendFileSync(logFile(id), '{"t":"item","i":6,"v":{"message":{"ro');

    const reopened = reopen(id);
    expect(reopened.map((h) => h.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(reopened[2].message.content).toBe("read a.ts and fix it");
    expect(reopened[3].toolCallStates?.[0].status).toBe("done");
    expect(reopened[3].toolCallStates?.[0].output?.[0].content).toBe(out[0]);
    expect(reopened[4].message.content).toBe(out[0]);
    expect(reopened[5].message.content).toBe("The bug is in line");
    expect(reopened[5].interrupted).toBe("reloaded");
    expect(findResumableTurn(reopened)).toEqual({
      kind: "continue",
      userIndex: 2,
      cancelledToolCall: false,
    });
  });

  it("a crash right after the message was sent offers Resume to send it again", async () => {
    const id = "crash-2";
    const m = logManager();
    const { messenger } = coreMessenger(m);
    await saveSessionToCore(
      messenger,
      session(id, [user("a"), assistant("b")]),
    );
    await saveSessionToCore(
      messenger,
      session(id, [user("a"), assistant("b"), user("lost before?")]),
      { checkpoint: "reloaded" },
    );
    await m.flush();
    const reopened = reopen(id);
    expect(reopened.at(-1)!.message.content).toBe("lost before?");
    expect(findResumableTurn(reopened)).toEqual({
      kind: "regenerate",
      userIndex: 2,
    });
  });

  it("the turn's own save at its end clears the cut-off mark", async () => {
    const id = "crash-3";
    const m = logManager();
    const { messenger } = coreMessenger(m);
    const q = user("q");
    const partial = assistant("all of it");
    await saveSessionToCore(messenger, session(id, [q]));
    await saveSessionToCore(messenger, session(id, [q, partial]), {
      checkpoint: "reloaded",
    });
    await saveSessionToCore(messenger, session(id, [q, partial]));
    await m.flush();
    const reopened = reopen(id);
    expect(reopened[1].interrupted).toBeUndefined();
    expect(findResumableTurn(reopened)).toBeUndefined();
  });
});

describe("readers on a blob-backed session", () => {
  const id = "readers-1";
  let original: Session;
  let loaded: Session;

  beforeAll(async () => {
    const outA = [big("file one", 40_000)];
    const outB = [big("file two", 30_000), "short tail"];
    const image = `data:image/png;base64,${"A".repeat(50_000)}`;
    const withImage: ChatHistoryItem = {
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is in this picture" },
          { type: "imageUrl", imageUrl: { url: image } },
        ],
      },
      contextItems: [],
      editorState: {
        type: "doc",
        content: [{ type: "image", attrs: { src: image } }],
      },
    };
    original = {
      ...session(id, [
        user("start"),
        toolCall("a", "done", outA),
        toolMessage("a", outA),
        assistant("read it"),
        withImage,
        assistant("a cat"),
        { ...user("again"), conversationSummary: "they read a file" },
        toolCall("b", "done", outB),
        toolMessage("b", outB),
        { ...assistant("stopped"), interrupted: "stopped" },
      ]),
      promptCache: { lastRequestAt: 1, lastInputTokens: 12_345 } as any,
    };
    const m = logManager();
    const { messenger } = coreMessenger(m);
    await saveSessionToCore(messenger, original);
    await m.flush();
    expect(fs.readdirSync(blobDir(id)).length).toBeGreaterThanOrEqual(3);
    expect(fs.statSync(logFile(id)).size).toBeLessThan(20_000);
    loaded = new HistoryManager().load(id);
  });

  it("loads the same session", () => {
    expect(loaded).toEqual(JSON.parse(JSON.stringify(original)));
  });

  it("constructMessages (the request)", () => {
    const build = (history: ChatHistoryItem[]) =>
      constructMessages(history, "You are helpful.", [], {});
    expect(build(loaded.history)).toEqual(build(original.history));
  });

  it("the context meter's estimate and its cache record", () => {
    expect(historyTokens(loaded.history)).toBe(historyTokens(original.history));
    expect(loaded.promptCache).toEqual(original.promptCache);
  });

  it("Choose what to keep (selective compaction)", () => {
    expect(listRemovable(loaded.history)).toEqual(
      listRemovable(original.history),
    );
  });

  it("Resume", () => {
    expect(findResumableTurn(loaded.history)).toEqual(
      findResumableTurn(original.history),
    );
  });

  it("Fork", () => {
    const opts = { sessionId: "fork-of-readers", upTo: 4 };
    expect(forkSession(loaded, opts)).toEqual(
      JSON.parse(JSON.stringify(forkSession(original, opts))),
    );
  });

  it("export and copy as markdown", () => {
    const when = new Date(0);
    expect(
      toMarkDown(
        loaded.history.map((h) => h.message),
        when,
      ),
    ).toBe(
      toMarkDown(
        original.history.map((h) => h.message),
        when,
      ),
    );
  });

  it("session list and title", () => {
    const listed = new HistoryManager()
      .list({})
      .find((s) => s.sessionId === id);
    expect(listed).toMatchObject({ title: "E2E", messageCount: 5 });
  });
});
