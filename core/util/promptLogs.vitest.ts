import * as fs from "fs";

import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";

import { ChatHistoryItem, PromptLog, Session } from "../index.js";
import historyManager from "./history.js";
import { getSessionFilePath } from "./paths.js";
import {
  DROPPED_PROMPT_MARKER,
  keepLatestPromptOnly,
  withoutPrompt,
  withoutPrompts,
} from "./promptLogs.js";
import { stripPromptsFromSessionBytes } from "./promptLogsFile.js";

const log = (n: number, prompt = `full prompt ${n}`): PromptLog => ({
  modelTitle: "m",
  modelProvider: "p",
  prompt,
  completion: `completion ${n}`,
});

const item = (
  role: "user" | "assistant",
  logs?: PromptLog[],
  content = "x",
): ChatHistoryItem => ({
  message: { role, content },
  contextItems: [],
  ...(logs && { promptLogs: logs }),
});

describe("withoutPrompt", () => {
  it("replaces the prompt with the marker and keeps the rest", () => {
    expect(withoutPrompt(log(1))).toEqual({
      ...log(1),
      prompt: DROPPED_PROMPT_MARKER,
    });
  });

  it("returns a log that is already dropped as it is", () => {
    const dropped = withoutPrompt(log(1));
    expect(withoutPrompt(dropped)).toBe(dropped);
  });
});

describe("keepLatestPromptOnly", () => {
  it("keeps the full prompt only on the newest request", () => {
    const out = keepLatestPromptOnly([
      item("user"),
      item("assistant", [log(1)]),
      item("user"),
      item("assistant", [log(2)]),
    ]);
    expect(out[1].promptLogs?.[0].prompt).toBe(DROPPED_PROMPT_MARKER);
    expect(out[3].promptLogs?.[0].prompt).toBe("full prompt 2");
    expect(out[1].promptLogs?.[0]).toMatchObject({
      completion: "completion 1",
      modelTitle: "m",
    });
  });

  it("keeps only the last of several logs on the newest item", () => {
    const out = keepLatestPromptOnly([item("assistant", [log(1), log(2)])]);
    expect(out[0].promptLogs?.map((l) => l.prompt)).toEqual([
      DROPPED_PROMPT_MARKER,
      "full prompt 2",
    ]);
  });

  it("looks past newer items that have no logs", () => {
    const out = keepLatestPromptOnly([
      item("assistant", [log(1)]),
      item("user"),
      item("assistant"),
    ]);
    expect(out[0].promptLogs?.[0].prompt).toBe("full prompt 1");
  });

  it("returns the same array when nothing needs dropping, and does not change its input", () => {
    const history = [item("user"), item("assistant", [log(1)])];
    expect(keepLatestPromptOnly(history)).toBe(history);
    const two = [item("assistant", [log(1)]), item("assistant", [log(2)])];
    const before = structuredClone(two);
    keepLatestPromptOnly(two);
    expect(two).toEqual(before);
  });
});

describe("withoutPrompts", () => {
  it("drops every prompt, the newest too", () => {
    const out = withoutPrompts([
      item("assistant", [log(1)]),
      item("assistant", [log(2)]),
    ]);
    expect(out.flatMap((i) => i.promptLogs!.map((l) => l.prompt))).toEqual([
      DROPPED_PROMPT_MARKER,
      DROPPED_PROMPT_MARKER,
    ]);
  });

  it("returns the same array when there is no prompt", () => {
    const history = [item("user"), item("assistant", [withoutPrompt(log(1))])];
    expect(withoutPrompts(history)).toBe(history);
  });
});

/**
 * A synthetic session of `turns` request/response pairs in which every
 * request's prompt is the whole conversation before it, as a real prompt is.
 * The prompts are slices of one string, so building it costs about one
 * conversation of memory; writing it out in full is what costs the square.
 */
function syntheticSession(turns: number): Session {
  const turnText = "word ".repeat(100); // 500 characters a message
  const conversation = turnText.repeat(turns * 2);
  const history: ChatHistoryItem[] = [];
  for (let t = 0; t < turns; t++) {
    history.push(item("user", undefined, turnText));
    const prompt = conversation.slice(0, (2 * t + 1) * turnText.length);
    history.push(item("assistant", [log(t, prompt)], turnText));
  }
  return {
    sessionId: uuidv4(),
    title: "synthetic",
    workspaceDirectory: "",
    history,
  };
}

function savedSize(session: Session): number {
  historyManager.save(session);
  const size = fs.statSync(getSessionFilePath(session.sessionId)).size;
  historyManager.delete(session.sessionId);
  return size;
}

describe("saving a session", () => {
  it("grows linearly with the conversation, not with the sum of its prompts", () => {
    const at100 = savedSize(syntheticSession(100));
    const at200 = savedSize(syntheticSession(200));
    // Twice the turns, about twice the file. With every prompt kept the 200
    // turn file would hold ~20 MB of prompts and be ~4x the 100 turn one.
    expect(at200 / at100).toBeGreaterThan(1.8);
    expect(at200 / at100).toBeLessThan(2.2);
    expect(at200).toBeLessThan(1_000_000);
  });

  it("writes no prompt, and keeps the completion", () => {
    const session = syntheticSession(3);
    historyManager.save(session);
    const loaded = historyManager.load(session.sessionId);
    historyManager.delete(session.sessionId);
    const logs = loaded.history.flatMap((i) => i.promptLogs ?? []);
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.prompt === DROPPED_PROMPT_MARKER)).toBe(true);
    expect(logs[2].completion).toBe("completion 2");
    // what was saved is not changed in memory
    expect(session.history[5].promptLogs![0].prompt).not.toBe(
      DROPPED_PROMPT_MARKER,
    );
  });
});

describe("loading a session saved with every prompt", () => {
  /** Writes a session file the old way, a few MB of prompts, in pieces. */
  function writeOldSessionFile(sessionId: string, prompts: number): void {
    const file = getSessionFilePath(sessionId);
    const fd = fs.openSync(file, "w");
    // Text that looks like the key, escapes and multi-byte characters must
    // survive: only real promptLogs keys are touched.
    const tricky = 'says "promptLogs": [ \\ \\" ] { é 日本 🙂';
    fs.writeSync(
      fd,
      `{\n  "sessionId": ${JSON.stringify(sessionId)},\n  "title": "old",\n  "workspaceDirectory": "",\n  "history": [\n`,
    );
    const big = "p".repeat(1_000_000);
    for (let i = 0; i < prompts; i++) {
      const prompt = `${tricky} ${big} "quoted" \\end`;
      const entry = {
        message: { role: "assistant", content: `${tricky} answer ${i}` },
        contextItems: [],
        promptLogs: [
          {
            modelTitle: "m",
            modelProvider: "p",
            completionOptions: {},
            prompt,
            completion: `${tricky} ${i}`,
          },
        ],
      };
      fs.writeSync(
        fd,
        `${i ? ",\n" : ""}${JSON.stringify(entry, undefined, 2)}`,
      );
    }
    fs.writeSync(fd, "\n  ]\n}\n");
    fs.closeSync(fd);
  }

  it("strips the prompts and keeps everything else", () => {
    const sessionId = uuidv4();
    writeOldSessionFile(sessionId, 8);
    const file = getSessionFilePath(sessionId);
    expect(fs.statSync(file).size).toBeGreaterThan(8_000_000);

    const session = historyManager.load(sessionId);
    expect(session.history).toHaveLength(8);
    for (const [i, h] of session.history.entries()) {
      expect(h.message.content).toBe(
        `says "promptLogs": [ \\ \\" ] { é 日本 🙂 answer ${i}`,
      );
      expect(h.promptLogs?.[0].prompt).toBe(DROPPED_PROMPT_MARKER);
      expect(h.promptLogs?.[0].completion).toMatch(/日本 🙂 \d$/);
    }

    // The next save writes it small
    historyManager.save(session);
    expect(fs.statSync(file).size).toBeLessThan(20_000);
    historyManager.delete(sessionId);
  });

  it("leaves a file without prompt logs as it is", () => {
    const bytes = Buffer.from('{"history":[{"message":"promptLogs"}]}');
    expect(stripPromptsFromSessionBytes(bytes)).toBe(bytes);
  });

  it("leaves text that only mentions the key alone", () => {
    const text = JSON.stringify({
      history: [{ message: { content: '"promptLogs": [{"prompt":"x"}]' } }],
    });
    const bytes = Buffer.from(text);
    expect(stripPromptsFromSessionBytes(bytes).toString()).toBe(text);
  });

  it("leaves a truncated file for the parser to judge", () => {
    const bytes = Buffer.from('{"history":[{"promptLogs":[{"prompt":"x');
    expect(stripPromptsFromSessionBytes(bytes)).toBe(bytes);
  });
});
