import fs from "fs";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { beginHeadlessRun, streamJsonHooks } from "./streamJsonHeadless.js";
import { setActiveStreamJson, StreamJsonRun } from "./streamJsonRun.js";

const schemaJson = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../spec/stream-json.schema.json"),
    "utf-8",
  ),
);
const lineSchema = z.fromJSONSchema(schemaJson);

/** A planted credential: it must never reach a line. */
const CANARY = "sk-ant-api03-CANARYCANARYCANARYCANARY0123456789";

function harness() {
  const lines: string[] = [];
  let clock = Date.parse("2026-11-12T10:00:00.000Z");
  const run = new StreamJsonRun({
    write: (l) => lines.push(l),
    now: () => (clock += 10),
  });
  run.init({
    sessionId: "s1",
    cliVersion: "1.0.0",
    model: "m",
    provider: "anthropic",
    cwd: "/w",
    mode: "normal",
  });
  return { run, lines, events: () => lines.map((l) => JSON.parse(l)) };
}

afterEach(() => {
  setActiveStreamJson(undefined);
  beginHeadlessRun({});
});

describe("stream-json reasoning lines", () => {
  it("writes a masked, schema-valid reasoning line before the reply's message", () => {
    const h = harness();
    h.run.requestDone();
    h.run.reasoning(`The key is ${CANARY}, so check it.`, 4200.4);
    h.run.message("Checked.");
    h.run.finish({ status: "success", exitCode: 0, result: "Checked." });

    expect(h.events().map((e) => e.type)).toEqual([
      "init",
      "usage",
      "reasoning",
      "message",
      "result",
    ]);
    const reasoning = h.events()[2];
    expect(reasoning).toMatchObject({ role: "assistant", durationMs: 4200 });
    expect(reasoning.content).toContain("so check it.");
    for (const line of h.lines) {
      expect(line).not.toContain(CANARY);
      expect(lineSchema.safeParse(JSON.parse(line)).success, line).toBe(true);
    }
  });

  it("writes nothing for empty reasoning and leaves out an unknown duration", () => {
    const h = harness();
    h.run.reasoning("   ");
    h.run.reasoning("Short.");
    const types = h.events().map((e) => e.type);
    expect(types).toEqual(["init", "reasoning"]);
    expect(h.events()[1]).not.toHaveProperty("durationMs");
  });

  it("is written only with --include-reasoning", () => {
    const h = harness();
    setActiveStreamJson(h.run);

    beginHeadlessRun({});
    expect(streamJsonHooks().callbacks?.onReasoningComplete).toBeUndefined();

    beginHeadlessRun({ includeReasoning: true });
    const onReasoningComplete =
      streamJsonHooks().callbacks?.onReasoningComplete;
    expect(onReasoningComplete).toBeDefined();
    onReasoningComplete!({
      text: "Thinking.",
      startAt: 1000,
      endAt: 3000,
      details: [],
    });
    expect(h.events().at(-1)).toMatchObject({
      type: "reasoning",
      content: "Thinking.",
      durationMs: 2000,
    });
  });
});
