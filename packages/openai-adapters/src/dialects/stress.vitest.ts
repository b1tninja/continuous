import { describe, expect, it } from "vitest";
import { recoverGlmXmlFromText, renderGlmXmlCall } from "./glmXml.js";
import {
  recoverHermesJsonFromText,
  renderHermesJsonCall,
} from "./hermesJson.js";
import {
  recoverKimiTokensFromText,
  renderKimiTokensCalls,
} from "./kimiTokens.js";
import { recoverKimiXtmlFromText, renderKimiXtmlCalls } from "./kimiXtml.js";
import { recoverLlamaJsonFromText, renderLlamaJsonCall } from "./llamaJson.js";
import { recoverMinimaxNsFromText, renderMinimaxNsCalls } from "./minimaxNs.js";
import {
  recoverMinimaxXmlFromText,
  renderMinimaxXmlCalls,
} from "./minimaxXml.js";
import {
  recoverDeepseekV31FromText,
  renderDeepseekV31Call,
} from "./deepseekV31.js";
import { recoverDsmlFromText, renderDsmlCall } from "./dsml.js";
import { recoverHarmonyFromText, renderHarmonyCall } from "./harmony.js";
import { recoverMistralFromText, renderMistralCall } from "./mistral.js";
import { DeepseekV31Recovery as HeldStage } from "./deepseekV31.js";
import { recoverDeepseekR1FromText } from "./deepseekR1.js";
import { WRAPPER_ROWS, recoverWrappedFromText } from "./wrapperDialects.js";
import {
  PythonicRecovery,
  recoverPythonicFromText,
  renderPythonicCall,
} from "./pythonic.js";
import {
  QwenXmlRecovery,
  recoverQwenXmlFromText,
  renderQwenXmlCall,
  type RecoveredCall,
} from "./qwenXml.js";
import {
  recoverToolcallJsonFromText,
  renderToolcallJsonCalls,
} from "./toolcallJson.js";

/**
 * Every dialect parser must take a very long reply (thousands of calls, or
 * megabytes of prose) without throwing and in roughly linear time: a parser
 * that recurses per call overflows the stack, and one that rescans per
 * character stalls the stream.
 */
const tools = [
  {
    name: "t",
    parameters: { properties: { p: { type: "string" } }, required: ["p"] },
  },
];
const call = (i: number) => ({ name: "t", arguments: { p: `v${i}` } });
const many = (n: number) => Array.from({ length: n }, (_, i) => call(i));
const join = (render: (c: ReturnType<typeof call>) => string) => (n: number) =>
  many(n).map(render).join("\n");

type Recover = (
  text: string,
  tools: { name: string; parameters?: unknown }[],
) => { text: string; calls: RecoveredCall[] };

const dialects: Array<[string, Recover, (n: number) => string, string]> = [
  ["qwen-xml", recoverQwenXmlFromText, join(renderQwenXmlCall), "<tool_call>"],
  ["glm-xml", recoverGlmXmlFromText, join(renderGlmXmlCall), "<tool_call>"],
  [
    "hermes-json",
    recoverHermesJsonFromText,
    join(renderHermesJsonCall),
    "<tool_call>",
  ],
  [
    "kimi-tokens",
    recoverKimiTokensFromText,
    (n) => renderKimiTokensCalls(many(n)),
    "<|tool_calls_section_begin|>",
  ],
  [
    "kimi-xtml",
    recoverKimiXtmlFromText,
    (n) => renderKimiXtmlCalls(many(n)),
    "<tool_call>",
  ],
  [
    "minimax-xml",
    recoverMinimaxXmlFromText,
    (n) => renderMinimaxXmlCalls(many(n)),
    "<minimax:tool_call>",
  ],
  [
    "minimax-ns-xml",
    recoverMinimaxNsFromText,
    (n) => renderMinimaxNsCalls(many(n)),
    "<minimax:tool_call>",
  ],
  [
    "toolcall-json",
    recoverToolcallJsonFromText,
    (n) => renderToolcallJsonCalls(many(n)),
    "<TOOLCALL>",
  ],
  ["llama-json", recoverLlamaJsonFromText, join(renderLlamaJsonCall), "{"],
  ["pythonic", recoverPythonicFromText, join(renderPythonicCall), "["],
];

// Generous: a quadratic parser on these inputs takes minutes, not seconds.
const BOUND_MS = 10000;

// A ratio of two wall-clock times measures the runner as much as the parser:
// on a shared CI machine it failed now and then with nothing changed. These
// cases carry the tag `perf`, which the default run leaves out (see
// vitest.config.ts); `npm run test:perf` runs them, as data. The bounded-time
// cases above them stay in every run and still catch a quadratic parser.
const PERF = { tags: ["perf"] };

function timed<T>(fn: () => T): { out: T; ms: number } {
  const t = Date.now();
  const out = fn();
  return { out, ms: Date.now() - t };
}

describe.each(dialects)("%s stress", (_name, recover, build, start) => {
  it("takes 5,000 calls without throwing, in bounded time", () => {
    const text = build(5000);
    const { out, ms } = timed(() => recover(text, tools));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.text.length + out.calls.length).toBeGreaterThan(0);
  });

  it("takes 5 MB of prose, with or without a start marker, in bounded time", () => {
    const prose = "The quick brown fox, jumps; over (the) lazy dog.\n".repeat(
      110_000,
    );
    for (const text of [prose, start + prose]) {
      const { out, ms } = timed(() => recover(text, tools));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(out.calls).toEqual([]);
      expect(out.text).toBe(text);
    }
  });
});

it("qwen-xml recovers all of 5,000 calls", () => {
  const r = recoverQwenXmlFromText(join(renderQwenXmlCall)(5000), tools);
  expect(r.calls).toHaveLength(5000);
  expect(r.text).toBe("");
});

/**
 * A reply that quotes a call marker many times inside backticks, or fences a
 * marker inside prose, must stay linear: the check for "is this marker quoted"
 * once rescanned the whole reply per marker.
 */
const markerOf = (rendered: string, len: number) => rendered.slice(0, len);
const first = call(0);
const quotedCases: Array<[string, Recover, string]> = [
  ...dialects.map(
    ([name, recover, , start]) =>
      [name, recover, start] as [string, Recover, string],
  ),
  ["harmony", recoverHarmonyFromText, "<|channel|>"],
  ["mistral", recoverMistralFromText, "[TOOL_CALLS]"],
  [
    "dsml",
    recoverDsmlFromText,
    markerOf(renderDsmlCall(first), renderDsmlCall(first).indexOf("function")),
  ],
  [
    "deepseek-v31",
    recoverDeepseekV31FromText,
    markerOf(renderDeepseekV31Call(first), "<｜tool▁calls▁begin｜>".length),
  ],
  ["deepseek-r1", recoverDeepseekR1FromText, "<｜tool▁calls▁begin｜>"],
  ...WRAPPER_ROWS.map(
    (row) =>
      [
        row.dialect,
        (text: string, t: Parameters<Recover>[1]) =>
          recoverWrappedFromText(row.dialect, text, t),
        row.open,
      ] as [string, Recover, string],
  ),
];
void renderHarmonyCall;
void renderMistralCall;

const quoted = (marker: string, n: number) =>
  `Use \`${marker}\` to start; `.repeat(n);
const fenced = (marker: string, bytes: number) =>
  `Prose line, with (parens); and more.
\`\`\`text
${marker}
\`\`\`
`.repeat(Math.ceil(bytes / 70));

function inputsFor(marker: string, n: number): Array<[string, string]> {
  return [
    ["quoted", quoted(marker, n)],
    ["held then quoted", marker + quoted(marker, n)],
    ["fenced", fenced(marker, n * 1000)],
    ["held then fenced", marker + fenced(marker, n * 1000)],
  ];
}

describe.each(quotedCases)("%s quoted markers", (_name, recover, marker) => {
  it("takes 5,000 quoted markers and 5 MB of fenced prose in bounded time", () => {
    for (const [label, text] of inputsFor(marker, 5000)) {
      const { out, ms } = timed(() => recover(text, tools));
      expect(ms, label).toBeLessThan(BOUND_MS);
      if (out.calls.length === 0) expect(out.text, label).toBe(text);
    }
  });

  it("does not take three times as long for twice the input", PERF, () => {
    const best = (text: string) =>
      Math.min(...[0, 1, 2].map(() => timed(() => recover(text, tools)).ms));
    for (const label of ["quoted", "held then quoted", "fenced"]) {
      const pick = (n: number) =>
        inputsFor(marker, n).find(([l]) => l === label)![1];
      const small = best(pick(10_000));
      const large = best(pick(20_000));
      // The floor keeps a fast, noisy small run from failing the ratio.
      expect(large, label).toBeLessThan(3 * Math.max(small, 40));
    }
  });
});

/**
 * The streaming path takes a reply a few characters at a time; a stage that
 * does work proportional to everything seen so far on each chunk is quadratic
 * in the reply even when its one-shot form is not.
 */
const streamers: Array<[string, () => { push(c: string): unknown }, string]> = [
  ["qwen-xml", () => new QwenXmlRecovery(tools), "<tool_call>"],
  ["pythonic", () => new PythonicRecovery(tools), "t("],
  ["held block, blank lead", () => new HeldStage(tools), " \n"],
];

describe.each(streamers)("%s streamed", (_name, make, unit) => {
  const run = (chars: number) => {
    const stage = make();
    const text = `Use \`${unit}\` to start. `.repeat(Math.ceil(chars / 30));
    const start = Date.now();
    // Whitespace-only for the held block, so it stays undecided throughout.
    const body = unit === " \n" ? unit.repeat(chars / 2) : text;
    for (let i = 0; i < body.length; i += 3) stage.push(body.slice(i, i + 3));
    return Date.now() - start;
  };

  it("takes a long reply three characters at a time", () => {
    expect(run(300_000)).toBeLessThan(BOUND_MS);
  });

  it("does not take three times as long for twice the reply", PERF, () => {
    const small = Math.min(run(100_000), run(100_000));
    const large = Math.min(run(200_000), run(200_000));
    expect(large).toBeLessThan(3 * Math.max(small, 40));
  });
});
