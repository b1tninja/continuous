import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PromptLog } from "../index.js";

import {
  DROPPED_PROMPT_MARKER,
  feedbackPromptLogs,
  withoutPrompt,
  withoutPromptKeepingHash,
  withoutPrompts,
} from "./promptLogs.js";

const log = (n: number, prompt = `full prompt ${n} – é`): PromptLog => ({
  modelTitle: "m",
  modelProvider: "p",
  prompt,
  completion: `completion ${n}`,
});

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("withoutPromptKeepingHash (PERF10)", () => {
  it("drops the prompt and keeps its UTF-8 size and SHA-256", () => {
    const original = log(1);
    expect(withoutPromptKeepingHash(original)).toEqual({
      ...original,
      prompt: DROPPED_PROMPT_MARKER,
      promptBytes: Buffer.byteLength(original.prompt, "utf8"),
      promptSha256: sha(original.prompt),
    });
  });

  it("returns a dropped log as it is, so the hash of the real prompt stays", () => {
    const dropped = withoutPromptKeepingHash(log(1));
    expect(withoutPromptKeepingHash(dropped)).toBe(dropped);
    expect(withoutPrompt(dropped)).toBe(dropped);
    expect(withoutPrompts([{ ...item(), promptLogs: [dropped] }])[0]).toEqual({
      ...item(),
      promptLogs: [dropped],
    });
  });

  it("is not what the save path uses: withoutPrompt hashes nothing", () => {
    expect(withoutPrompt(log(1))).not.toHaveProperty("promptSha256");
  });
});

function item() {
  return {
    message: { role: "assistant" as const, content: "x" },
    contextItems: [],
  };
}

describe("feedbackPromptLogs (PERF10)", () => {
  it("sends one full prompt, the newest request's, and sizes and hashes for the rest", () => {
    const first = log(1);
    const second = log(2);
    const newest = log(3);
    const sent = feedbackPromptLogs([
      withoutPromptKeepingHash(first),
      withoutPromptKeepingHash(second),
      newest,
    ]);
    expect(sent.map((l) => l.prompt)).toEqual([
      `[prompt not sent: older request, ${Buffer.byteLength(first.prompt)} bytes, sha256 ${sha(first.prompt)}]`,
      `[prompt not sent: older request, ${Buffer.byteLength(second.prompt)} bytes, sha256 ${sha(second.prompt)}]`,
      newest.prompt,
    ]);
    expect(sent.filter((l) => l.prompt.startsWith("full prompt"))).toHaveLength(
      1,
    );
    // completions and models stay; the summary fields are not sent twice
    expect(sent.map((l) => l.completion)).toEqual([
      "completion 1",
      "completion 2",
      "completion 3",
    ]);
    for (const l of sent) {
      expect(l).not.toHaveProperty("promptBytes");
      expect(l).not.toHaveProperty("promptSha256");
    }
  });

  it("sends no full prompt for an older item whose prompts were all dropped", () => {
    const sent = feedbackPromptLogs([
      withoutPromptKeepingHash(log(1)),
      withoutPromptKeepingHash(log(2)),
    ]);
    expect(sent.every((l) => l.prompt.startsWith("[prompt not sent"))).toBe(
      true,
    );
  });

  it("never sends a full prompt that is not the item's last, even if one survived", () => {
    const sent = feedbackPromptLogs([log(1), log(2)]);
    expect(sent[0].prompt).toBe(DROPPED_PROMPT_MARKER);
    expect(sent[1].prompt).toBe(log(2).prompt);
  });

  it("sends the marker for a log dropped without a hash (a reloaded session)", () => {
    expect(feedbackPromptLogs([withoutPrompt(log(1))])[0].prompt).toBe(
      DROPPED_PROMPT_MARKER,
    );
  });

  it("sends nothing for an item without logs", () => {
    expect(feedbackPromptLogs(undefined)).toEqual([]);
    expect(feedbackPromptLogs([])).toEqual([]);
  });
});
