import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatMessage, Tool, ToolCallDelta } from "../../index.js";
import { compileChatMessages, countTokens } from "../countTokens.js";
import { requestBudgetForModel } from "../requestBudget.js";
import Bedrock from "./Bedrock.js";

/**
 * Live multi-turn implementation against the windows Claude is actually run
 * with. A few hundred output tokens cannot catch a second turn that no longer
 * fits the context window.
 *
 * Opt-in:
 *   RUN_LIVE_PROVIDER_TESTS=1 RUN_BEDROCK_LIVE=1 npx vitest run llm/llms/Claude.implement.live.vitest.ts
 *
 * Windows covered:
 *   published  — the model card (200k context, 64k or 32k output)
 *   configured — models.yaml for the Anthropic Claude entries (100k context, 128k output)
 *   catalog    — llm-info for Claude 5 (1M context, 128k output), sent to a model we can call
 *   long       — the same task, but the file the agent must read is ~90k tokens
 */
const live =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  process.env.RUN_BEDROCK_LIVE === "1"
    ? describe
    : (name: string, fn: () => void) =>
        describe.skip(
          `${name} (skipped: set RUN_LIVE_PROVIDER_TESTS=1 and RUN_BEDROCK_LIVE=1)`,
          fn,
        );

const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const OPUS = "us.anthropic.claude-opus-4-1-20250805-v1:0";

/** Product default (core/llm/constants.ts DEFAULT_REASONING_TOKENS). */
const REASONING_BUDGET = 2048;

interface Case {
  id: string;
  model: string;
  /** What compile uses as the context window. */
  contextLength: number;
  /** What the request sends as max output. */
  maxTokens: number;
  reasoning: boolean;
  budget?: number;
  /** When set, docs/journal.md is about this many tokens and the tests require seed(). */
  journalTokens?: number;
  maxTurns: number;
}

const CASES: Case[] = [
  {
    id: "haiku published 200k/64k reasoning on",
    model: HAIKU,
    contextLength: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    maxTurns: 8,
  },
  {
    id: "sonnet published 200k/64k reasoning on",
    model: SONNET,
    contextLength: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    maxTurns: 8,
  },
  {
    id: "opus published 200k/32k reasoning on",
    model: OPUS,
    contextLength: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    maxTurns: 8,
  },
  {
    id: "haiku published 200k/64k reasoning off",
    model: HAIKU,
    contextLength: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    maxTurns: 8,
  },
  {
    id: "haiku reasoning budget 8192, published 200k/64k",
    model: HAIKU,
    contextLength: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    budget: 8192,
    maxTurns: 8,
  },
  {
    id: "sonnet configured 100k/128k reasoning on",
    model: SONNET,
    contextLength: 100_000,
    maxTokens: 128_000,
    reasoning: true,
    maxTurns: 8,
  },
  {
    id: "haiku configured 100k/128k reasoning on",
    model: HAIKU,
    contextLength: 100_000,
    maxTokens: 128_000,
    reasoning: true,
    maxTurns: 8,
  },
  {
    id: "sonnet catalog 1M/128k reasoning on",
    model: SONNET,
    contextLength: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    maxTurns: 8,
  },
  {
    id: "sonnet long file, published 200k/64k",
    model: SONNET,
    contextLength: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    journalTokens: 90_000,
    maxTurns: 4,
  },
  {
    id: "haiku long file, published 200k/64k",
    model: HAIKU,
    contextLength: 200_000,
    maxTokens: 64_000,
    reasoning: true,
    journalTokens: 90_000,
    maxTurns: 4,
  },
  {
    id: "sonnet long file, configured 100k/128k",
    model: SONNET,
    contextLength: 100_000,
    maxTokens: 128_000,
    reasoning: true,
    journalTokens: 90_000,
    maxTurns: 4,
  },
  {
    id: "haiku long file, configured 100k/128k",
    model: HAIKU,
    contextLength: 100_000,
    maxTokens: 128_000,
    reasoning: true,
    journalTokens: 90_000,
    maxTurns: 4,
  },
  {
    id: "sonnet long file, 200k window with 128k output",
    model: SONNET,
    contextLength: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    journalTokens: 90_000,
    maxTurns: 4,
  },
];

const TOOLS: Tool[] = [
  {
    type: "function",
    displayTitle: "List files",
    readonly: true,
    group: "test",
    function: {
      name: "list_files",
      description: "List every file in the workspace, relative paths.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    displayTitle: "Read file",
    readonly: true,
    group: "test",
    function: {
      name: "read_file",
      description: "Read a workspace file. path is relative to the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    displayTitle: "Write file",
    readonly: false,
    group: "test",
    function: {
      name: "write_file",
      description:
        "Create or replace a workspace file. path is relative. content is the full file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    displayTitle: "Run tests",
    readonly: false,
    group: "test",
    function: {
      name: "run_tests",
      description: "Run the ledger tests. No arguments.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function log(line: string) {
  process.stderr.write(`${line}\n`);
}

function textWithTokens(target: number, model: string): { text: string; tokens: number } {
  const unit = "2024-06-15,office,standup coffee,-125\n";
  const sample = unit.repeat(400);
  const perLine = Math.max(1, countTokens(sample, model) / 400);
  let lines = Math.max(1, Math.ceil(target / perLine));
  let text = unit.repeat(lines);
  let tokens = countTokens(text, model);
  if (tokens < target) {
    const extra = Math.ceil((target - tokens) / perLine);
    lines += extra;
    text += unit.repeat(extra);
    tokens = countTokens(text, model);
  }
  return { text, tokens };
}

function writeProject(root: string, journal: string | undefined, expectedSum: number, lineCount: number) {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "spec.md"),
    [
      "# Ledger",
      "",
      "Money is integer cents. parseAmount accepts `$1.50`, `-$2.00`, and `0.5` (fifty cents).",
      "formatAmount prints `$1.50`, `-$2.00`, and `$0.00`.",
      "",
      "Ledger.add takes `{ id, category, memo, cents }`. Trim the memo.",
      "A repeated id throws. balance() is the sum of cents.",
      "byCategory(name) returns the entries in that category, in the order they were added.",
      journal
        ? "seed(text) parses docs/journal.md. Each line is `date,category,memo,cents`. Give them ids j0, j1, ... in order. Then balance and byCategory see those entries."
        : "",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "docs", "rules.md"),
    [
      "# Rules",
      "",
      "- category and id are required and must be non-empty after trimming",
      "- memo is stored trimmed; an empty memo is allowed",
      "- cents is an integer; reject anything else with a throw",
      "- duplicate id throws before the entry is stored",
      "- byCategory returns copies of the stored entries, not the internal array",
      "",
    ].join("\n"),
  );
  if (journal) {
    fs.writeFileSync(path.join(root, "docs", "journal.md"), journal);
  }
  fs.writeFileSync(
    path.join(root, "src", "ledger.mjs"),
    [
      "export function parseAmount() {",
      '  throw new Error("not implemented");',
      "}",
      "export function formatAmount() {",
      '  throw new Error("not implemented");',
      "}",
      "export class Ledger {",
      "  add() {",
      '    throw new Error("not implemented");',
      "  }",
      "  balance() {",
      '    throw new Error("not implemented");',
      "  }",
      "  byCategory() {",
      '    throw new Error("not implemented");',
      "  }",
      "  seed() {",
      '    throw new Error("not implemented");',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  const seedTest = journal
    ? [
        'test("seed loads the journal", () => {',
        "  const ledger = new Ledger();",
        '  const text = fs.readFileSync(new URL("../docs/journal.md", import.meta.url), "utf8");',
        "  ledger.seed(text);",
        `  assert.equal(ledger.balance(), ${expectedSum});`,
        `  assert.equal(ledger.byCategory("office").length, ${lineCount});`,
        "});",
        "",
      ].join("\n")
    : "";
  fs.writeFileSync(
    path.join(root, "test", "ledger.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import test from "node:test";',
      'import { Ledger, formatAmount, parseAmount } from "../src/ledger.mjs";',
      "",
      'test("parseAmount reads dollars and cents", () => {',
      '  assert.equal(parseAmount("$1.50"), 150);',
      '  assert.equal(parseAmount("-$2.00"), -200);',
      '  assert.equal(parseAmount("0.5"), 50);',
      "});",
      "",
      'test("formatAmount prints a dollar string", () => {',
      '  assert.equal(formatAmount(150), "$1.50");',
      '  assert.equal(formatAmount(-200), "-$2.00");',
      '  assert.equal(formatAmount(0), "$0.00");',
      "});",
      "",
      'test("ledger sums entries and rejects a duplicate id", () => {',
      "  const ledger = new Ledger();",
      '  ledger.add({ id: "a", category: "office", memo: " Coffee ", cents: -450 });',
      '  ledger.add({ id: "b", category: "office", memo: "Pens", cents: -125 });',
      '  ledger.add({ id: "c", category: "sales", memo: "Invoice", cents: 2000 });',
      "  assert.equal(ledger.balance(), 1425);",
      "  assert.deepEqual(ledger.byCategory(\"office\"), [",
      '    { id: "a", category: "office", memo: "Coffee", cents: -450 },',
      '    { id: "b", category: "office", memo: "Pens", cents: -125 },',
      "  ]);",
      '  assert.throws(() => ledger.add({ id: "a", category: "x", memo: "y", cents: 1 }));',
      "});",
      "",
      seedTest,
    ].join("\n"),
  );
}

function inside(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("path escapes the workspace");
  }
  return full;
}

function listFiles(root: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort().join("\n");
}

function runTool(root: string, name: string, args: Record<string, unknown>): string {
  if (name === "list_files") return listFiles(root);
  if (name === "read_file") {
    const rel = String(args.path ?? "");
    return fs.readFileSync(inside(root, rel), "utf8");
  }
  if (name === "write_file") {
    const rel = String(args.path ?? "");
    const full = inside(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(args.content ?? ""));
    return `wrote ${rel} (${String(args.content ?? "").length} chars)`;
  }
  if (name === "run_tests") {
    const node = process.execPath;
    const result = spawnSync(
      node,
      ["--test", path.join(root, "test", "ledger.test.mjs")],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-12_000);
    return `exit ${result.status}\n${text}`;
  }
  return `unknown tool ${name}`;
}

function argsOf(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function collapse(chunks: ChatMessage[]): {
  messages: ChatMessage[];
  calls: { id: string; name: string; arguments: string }[];
  thinkChars: number;
  answerChars: number;
  stopReason?: string;
  promptTokens?: number;
  completionTokens?: number;
} {
  let thinking = "";
  let signature: string | undefined;
  let answer = "";
  const calls = new Map<string, { name: string; arguments: string }>();
  let stopReason: string | undefined;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  for (const chunk of chunks) {
    const usage = chunk.usage as
      | {
          promptTokens?: number;
          completionTokens?: number;
          response?: { stopReason?: string };
        }
      | undefined;
    if (usage?.response?.stopReason) stopReason = usage.response.stopReason;
    if (typeof usage?.promptTokens === "number") promptTokens = usage.promptTokens;
    if (typeof usage?.completionTokens === "number") {
      completionTokens = usage.completionTokens;
    }
    if (chunk.role === "thinking") {
      if (typeof chunk.content === "string") thinking += chunk.content;
      if (chunk.signature) signature = chunk.signature;
    } else if (chunk.role === "assistant") {
      if (typeof chunk.content === "string") answer += chunk.content;
      for (const call of chunk.toolCalls ?? []) {
        const delta = call as ToolCallDelta;
        const id = delta.id || `idx-${delta.index ?? calls.size}`;
        const prev = calls.get(id) ?? { name: "", arguments: "" };
        if (delta.function?.name) prev.name += delta.function.name;
        if (delta.function?.arguments) prev.arguments += delta.function.arguments;
        calls.set(id, prev);
      }
    }
  }
  const messages: ChatMessage[] = [];
  if (thinking || signature) {
    messages.push({
      role: "thinking",
      content: thinking,
      ...(signature ? { signature } : {}),
    });
  }
  const list = [...calls.entries()].map(([id, call]) => ({
    id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
  if (answer || list.length) {
    messages.push({
      role: "assistant",
      content: answer,
      ...(list.length ? { toolCalls: list } : {}),
    });
  }
  return {
    messages,
    calls: list.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    thinkChars: thinking.length,
    answerChars: answer.length,
    stopReason,
    promptTokens,
    completionTokens,
  };
}

function sentMaxTokens(
  messages: ChatMessage[],
  options: {
    model: string;
    maxTokens: number;
    tools: Tool[];
  },
  contextLength: number,
): number {
  return requestBudgetForModel({
    model: options.model,
    provider: "bedrock",
    configured: options.maxTokens,
    contextLength,
    messages,
    tools: options.tools,
  }).maxTokens;
}

interface TurnLog {
  turn: number;
  stopped?: "compile" | "api";
  error?: string;
  stopReason?: string;
  tools?: string[];
  thinkChars?: number;
  answerChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  sentMaxTokens?: number;
  compiledTokens?: number;
  pruned?: boolean;
}

async function runCase(spec: Case): Promise<{
  turns: TurnLog[];
  passed: boolean;
  error?: string;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-impl-"));
  let journalTokens = 0;
  let expectedSum = 0;
  let lineCount = 0;
  let journal: string | undefined;
  if (spec.journalTokens) {
    const built = textWithTokens(spec.journalTokens, spec.model);
    journal = built.text;
    journalTokens = built.tokens;
    lineCount = built.text.split("\n").filter((line) => line.length > 0).length;
    expectedSum = lineCount * -125;
  }
  writeProject(root, journal, expectedSum, lineCount);
  const task = journal
    ? `Implement the ledger in ${root}. Read docs/spec.md, docs/rules.md, docs/journal.md, and test/ledger.test.mjs. Journal is ${journalTokens} tokens. Write src/ledger.mjs so the tests pass, run the tests, and fix failures. Do not stop after one read.`
    : "Implement the ledger. Read docs/spec.md, docs/rules.md, and test/ledger.test.mjs. Write src/ledger.mjs so the tests pass, run the tests, and fix failures. Do not stop after one read.";
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a coding agent. Use the tools. A turn that only reads a file is unfinished. Keep going until the tests pass.",
    },
    { role: "user", content: task },
  ];
  const llm = new Bedrock({
    model: spec.model,
    region: process.env.AWS_REGION ?? "us-east-1",
    capabilities: { tools: true },
  });
  const options = {
    model: spec.model,
    maxTokens: spec.maxTokens,
    reasoning: spec.reasoning,
    ...(spec.reasoning
      ? { reasoningBudgetTokens: spec.budget ?? REASONING_BUDGET }
      : { temperature: 0 }),
    tools: TOOLS,
  };
  const turns: TurnLog[] = [];
  let passed = false;
  let error: string | undefined;
  try {
    for (let turn = 1; turn <= spec.maxTurns; turn++) {
      let compiled: ReturnType<typeof compileChatMessages>;
      try {
        compiled = compileChatMessages({
          modelName: spec.model,
          msgs: messages,
          knownContextLength: spec.contextLength,
          maxTokens: spec.maxTokens,
          supportsImages: false,
          tools: TOOLS,
          contextClass: "cloud",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error = message.slice(0, 500);
        turns.push({ turn, stopped: "compile", error });
        break;
      }
      const compiledTokens = compiled.compiledChatMessages.reduce(
        (sum, message) =>
          sum +
          countTokens(
            typeof message.content === "string" ? message.content : "",
            spec.model,
          ),
        0,
      );
      const sent = sentMaxTokens(
        compiled.compiledChatMessages,
        options,
        spec.contextLength,
      );
      const chunks: ChatMessage[] = [];
      try {
        for await (const message of llm.streamChat(
          compiled.compiledChatMessages,
          new AbortController().signal,
          options,
        )) {
          chunks.push(message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error = message.slice(0, 500);
        turns.push({
          turn,
          stopped: "api",
          error,
          sentMaxTokens: sent,
          compiledTokens,
          pruned: compiled.didPrune,
        });
        break;
      }
      const collapsed = collapse(chunks);
      turns.push({
        turn,
        stopReason: collapsed.stopReason,
        tools: collapsed.calls.map((call) => call.name),
        thinkChars: collapsed.thinkChars,
        answerChars: collapsed.answerChars,
        promptTokens: collapsed.promptTokens,
        completionTokens: collapsed.completionTokens,
        sentMaxTokens: sent,
        compiledTokens,
        pruned: compiled.didPrune,
      });
      messages.push(...collapsed.messages);
      if (collapsed.calls.length === 0) break;
      for (const call of collapsed.calls) {
        let content: string;
        try {
          content = runTool(root, call.name, argsOf(call.arguments));
        } catch (err) {
          content = err instanceof Error ? err.message : String(err);
        }
        if (content.includes("\n# pass ") || content.includes("# tests ")) {
          // node:test summary
        }
        if (content.startsWith("exit 0")) passed = true;
        messages.push({ role: "tool", content, toolCallId: call.id });
      }
      if (passed) break;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { turns, passed, error };
}

live("Claude implements a ledger across turns (live)", () => {
  it.each(CASES)(
    "$id",
    async (spec) => {
      const started = Date.now();
      const report = await runCase(spec);
      const brief = report.turns
        .map((turn) => {
          if (turn.stopped) {
            return `t${turn.turn} ${turn.stopped} max=${turn.sentMaxTokens ?? "-"} compiled=${turn.compiledTokens ?? "-"} ${turn.error}`;
          }
          return `t${turn.turn} stop=${turn.stopReason ?? "-"} tools=${(turn.tools ?? []).join("+") || "-"} think=${turn.thinkChars} answer=${turn.answerChars} prompt=${turn.promptTokens ?? "-"} out=${turn.completionTokens ?? "-"} sentMax=${turn.sentMaxTokens ?? "-"} compiled=${turn.compiledTokens} pruned=${turn.pruned}`;
        })
        .join(" || ");
      log(
        `CASE ${spec.id} | ${((Date.now() - started) / 1000).toFixed(1)}s | passed=${report.passed} | ${brief}`,
      );
      const successful = report.turns.filter((turn) => !turn.stopped);
      expect(
        report.error,
        `${spec.id} stopped: ${report.error ?? ""}`,
      ).toBeUndefined();
      expect(successful.length, `${spec.id} model turns`).toBeGreaterThanOrEqual(2);
      expect(
        successful.some((turn) => (turn.tools ?? []).length > 0),
        `${spec.id} never called a tool`,
      ).toBe(true);
    },
    480_000,
  );
});
