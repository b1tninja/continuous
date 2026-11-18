import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifyReply,
  parseCodeblock,
  parseToolcallJson,
  schemaFit,
  scoreReply,
} from "../lib/classify.mjs";
import { Budget, machineFacts, modelGuard, modelsDir } from "../lib/guards.mjs";
import { assertLoopback } from "../lib/ollama.mjs";
import { assertWritable, roots } from "../lib/paths.mjs";
import { renderToolsPrompt, TEXT_STYLES } from "../lib/prompts.mjs";
import { buildReport } from "../lib/report.mjs";
import { disjoint, fmtRate, median, wilson } from "../lib/stats.mjs";
import {
  expandSuite,
  loadSuite,
  SUITE_NAMES,
  toolSet,
} from "../lib/suites.mjs";
import { loadProduct } from "../adapter.mjs";

const product = await loadProduct();
const hasParsers = Boolean(product.parsers["qwen-xml"]);
const hasDetect = Boolean(product.detect);
const READ = {
  name: "read_file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

test("wilson matches the known interval for 1 of 8", () => {
  const w = wilson(1, 8);
  assert.ok(Math.abs(w.lo - 0.0224) < 0.001, String(w.lo));
  assert.ok(Math.abs(w.hi - 0.4709) < 0.001, String(w.hi));
  assert.equal(fmtRate(wilson(1, 8)), "1/8 = 13% [2%, 47%]");
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, rate: 0, lo: 0, hi: 1 });
  assert.equal(fmtRate(wilson(0, 0)), "0/0 = n/a");
  assert.throws(() => wilson(3, 2), RangeError);
});

test("disjoint intervals say moved, overlapping ones do not", () => {
  assert.equal(disjoint(wilson(1, 20), wilson(19, 20)), true);
  assert.equal(disjoint(wilson(3, 8), wilson(5, 8)), false);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("only loopback base URLs are accepted", () => {
  assert.equal(
    assertLoopback("http://127.0.0.1:11434"),
    "http://127.0.0.1:11434",
  );
  assert.equal(assertLoopback("http://localhost:1"), "http://localhost:1");
  assert.throws(() => assertLoopback("http://10.0.0.5:11434"), /non-loopback/);
  assert.throws(
    () => assertLoopback("https://api.example.com"),
    /non-loopback/,
  );
  assert.equal(
    assertLoopback("http://10.0.0.5:11434", true),
    "http://10.0.0.5:11434",
  );
});

test("writes outside results, profiles and temp are refused", () => {
  const r = roots({ tmp: path.join(os.tmpdir(), "lab-test-tmp") });
  assert.doesNotThrow(() => assertWritable(r.results + "/x.jsonl", r));
  assert.doesNotThrow(() => assertWritable(r.profiles + "/m.json", r));
  assert.throws(
    () => assertWritable(r.results + "/../adapter.mjs", r),
    /outside/,
  );
  assert.throws(() => assertWritable("/etc/passwd", r), /outside/);
  assert.throws(
    () => assertWritable("D:/code/core/util/toolDialectPresetTable.ts", r),
    /outside/,
  );
});

test("model guard: size limits, free VRAM, embedding and OCR models", () => {
  const lim = { maxVramGB: 8, maxRamGB: 16 };
  assert.equal(
    modelGuard({ name: "a", sizeBytes: 5e9, capabilities: ["tools"] }, lim).ok,
    true,
  );
  assert.match(
    modelGuard(
      { name: "b", sizeBytes: 17e9, capabilities: ["tools"] },
      lim,
    ).reasons.join(),
    /--max-vram 8/,
  );
  assert.match(
    modelGuard(
      { name: "b", sizeBytes: 17e9, capabilities: ["tools"] },
      { maxVramGB: 30, maxRamGB: 10 },
    ).reasons.join(),
    /--max-ram 10/,
  );
  assert.match(
    modelGuard(
      { name: "c", sizeBytes: 5e9, capabilities: ["embedding"] },
      lim,
    ).reasons.join(),
    /embedding/,
  );
  assert.match(
    modelGuard(
      { name: "glm-ocr:latest", sizeBytes: 2e9, capabilities: ["tools"] },
      lim,
    ).reasons.join(),
    /OCR/,
  );
  assert.match(
    modelGuard({ name: "d", sizeBytes: 7e9 }, lim, {
      gpus: [{ freeGB: 3 }],
    }).reasons.join(),
    /free now/,
  );
});

test("budget stops on requests and on the clock", () => {
  let now = 0;
  const b = new Budget({ maxRequests: 2, maxMs: 1000, now: () => now });
  assert.equal(b.exhausted(), null);
  b.spend(2);
  assert.match(b.exhausted(), /request budget/);
  const c = new Budget({ maxRequests: 99, maxMs: 1000, now: () => now });
  now = 1500;
  assert.match(c.exhausted(), /wall-clock/);
});

test("machine facts report the models directory from OLLAMA_MODELS", () => {
  assert.equal(modelsDir({ OLLAMA_MODELS: "X:\\m" }), "X:\\m");
  const f = machineFacts({
    env: { OLLAMA_MODELS: "." },
    exec: () => "NVIDIA Test, 32607, 1721, 30467\n",
  });
  assert.equal(f.gpus[0].name, "NVIDIA Test");
  assert.ok(f.gpus[0].totalGB > 32 && f.gpus[0].totalGB < 35);
  assert.equal(
    machineFacts({
      exec: () => {
        throw new Error("no smi");
      },
    }).gpus,
    undefined,
  );
});

test("own parsers: codeblock and TOOLCALL", () => {
  const cb = parseCodeblock(
    'Sure.\n```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\n"a b.txt"\nEND_ARG\n```',
  );
  assert.deepEqual(cb, [{ name: "read_file", arguments: { path: "a b.txt" } }]);
  assert.equal(parseCodeblock("no block"), undefined);
  assert.deepEqual(
    parseToolcallJson(
      '<TOOLCALL>[{"name":"x","arguments":{"n":1}}]</TOOLCALL>',
    ),
    [{ name: "x", arguments: { n: 1 } }],
  );
  assert.equal(parseToolcallJson("<TOOLCALL>not json</TOOLCALL>"), undefined);
});

test("schemaFit checks required keys and types", () => {
  const p = {
    required: ["path", "n"],
    properties: { path: { type: "string" }, n: { type: "integer" } },
  };
  assert.equal(schemaFit({ path: "a", n: 3 }, p), true);
  assert.equal(schemaFit({ path: "a", n: "3" }, p), false);
  assert.equal(schemaFit({ path: "a" }, p), false);
});

test("classify: structured, prose, refusal, empty, bad arguments", () => {
  const tools = [READ];
  const s = classifyReply(
    { text: "", toolCalls: [{ name: "read_file", arguments: '{"path":"a"}' }] },
    tools,
    product,
  );
  assert.equal(s.outcome, "structured");
  assert.equal(
    classifyReply({ text: "Paris", toolCalls: [] }, tools, product).outcome,
    "prose",
  );
  assert.equal(
    classifyReply(
      { text: "I'm sorry, I can't access files.", toolCalls: [] },
      tools,
      product,
    ).outcome,
    "refused",
  );
  const empty = classifyReply({ text: "  ", toolCalls: [] }, tools, product);
  assert.equal(empty.outcome, "prose");
  assert.equal(empty.note, "empty reply");
  assert.equal(
    classifyReply(
      { text: "", toolCalls: [{ name: "read_file", arguments: "[1]" }] },
      tools,
      product,
    ).outcome,
    "format-broken",
  );
});

test("classify: a codeblock call is a text call, a mangled one is format-broken", () => {
  const tools = [READ];
  const ok = classifyReply(
    {
      text: '```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\n"a.txt"\nEND_ARG\n```',
      toolCalls: [],
    },
    tools,
    product,
  );
  assert.equal(ok.outcome, "text-call");
  assert.deepEqual(ok.recoveredBy, ["codeblock"]);
  const broken = classifyReply(
    { text: "```tool\nTOOL_NAME read_file path a.txt\n```", toolCalls: [] },
    tools,
    product,
  );
  assert.equal(broken.outcome, "format-broken");
});

test(
  "classify: qwen-xml text is detected and recovered by the product parsers",
  { skip: !(hasParsers && hasDetect) },
  () => {
    const text =
      "<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>";
    const c = classifyReply(
      { text, toolCalls: [] },
      [READ],
      product,
      "qwen-xml",
    );
    assert.equal(c.outcome, "text-call");
    assert.equal(c.detected, "qwen-xml");
    assert.ok(c.recoveredBy.includes("qwen-xml"));
    assert.deepEqual(c.calls, [
      { name: "read_file", arguments: { path: "src/a.ts" } },
    ]);
    const half = classifyReply(
      {
        text: "<tool_call>\n<function=read_file>\n<parameter=path>",
        toolCalls: [],
      },
      [READ],
      product,
    );
    assert.equal(half.outcome, "format-broken");
  },
);

test("scoring: valid call, wrong args, false call, parallel", () => {
  const tools = [READ];
  const calls = (...c) => ({
    calls: c.map(([name, arguments_]) => ({ name, arguments: arguments_ })),
  });
  assert.equal(
    scoreReply(
      calls(["read_file", { path: "a" }]),
      { tool: "read_file", args: { path: "a" } },
      tools,
    ).valid,
    true,
  );
  assert.equal(
    scoreReply(
      calls(["read_file", { path: "b" }]),
      { tool: "read_file", args: { path: "a" } },
      tools,
    ).argsOk,
    false,
  );
  assert.equal(
    scoreReply(calls(["read_file", {}]), { tool: "read_file" }, tools)
      .schemaValid,
    false,
  );
  assert.equal(scoreReply(calls(), { tool: "read_file" }, tools).valid, false);
  assert.deepEqual(
    scoreReply(calls(["read_file", { path: "a" }]), { none: true }, tools)
      .falseCall,
    true,
  );
  assert.equal(scoreReply(calls(), { none: true }, tools).valid, true);
  const par = {
    calls: [
      { tool: "read_file", args: { path: "a" } },
      { tool: "read_file", args: { path: "b" } },
    ],
  };
  assert.equal(
    scoreReply(calls(["read_file", { path: "a" }]), par, tools).valid,
    false,
  );
  assert.equal(
    scoreReply(
      {
        calls: [
          { name: "read_file", arguments: { path: "a" } },
          { name: "read_file", arguments: { path: "b" } },
        ],
      },
      par,
      tools,
    ).valid,
    true,
  );
});

test("every text style renders and names the tool and the example", () => {
  for (const style of TEXT_STYLES) {
    const p = renderToolsPrompt(style, [READ]);
    assert.ok(p.includes("read_file"), style);
    assert.ok(p.length > 200, style);
  }
  assert.throws(() => renderToolsPrompt("nope", [READ]));
});

test("suites expand: probes both ways, variants, leaks grid, tool sets", () => {
  const dp = expandSuite(loadSuite("dialect-probe"), {
    model: "m",
    preset: undefined,
    product,
    opts: {},
  });
  assert.equal(dp.filter((c) => c.mode === "native").length, 6);
  assert.equal(dp.filter((c) => c.mode === "text").length, 6);
  assert.ok(dp.filter((c) => c.mode === "native").every((c) => c.sendTools));
  assert.ok(
    dp
      .filter((c) => c.mode === "text")
      .every((c) => !c.sendTools && c.style === "codeblock"),
  );
  assert.equal(
    expandSuite(loadSuite("dialect-probe"), {
      model: "m",
      product,
      opts: { styles: "all", modes: "text" },
    }).length,
    6 * 7,
  );
  const pv = expandSuite(loadSuite("prompt-variants"), {
    model: "m",
    product,
    opts: {},
  });
  assert.equal(pv.length, 3 * 7);
  assert.equal(new Set(pv.map((c) => c.id)).size, pv.length);
  const lk = expandSuite(loadSuite("leaks"), { model: "m", product, opts: {} });
  assert.ok(
    lk.length > 0 &&
      lk.every((c) => c.tools.some((t) => t.name === c.expect.tool)),
  );
  const full = expandSuite(loadSuite("leaks"), {
    model: "m",
    product,
    opts: { fullGrid: true },
  });
  assert.ok(
    full.some((c) => c.stream) &&
      full.some((c) => c.temperature === 0.7) &&
      full.some((c) => c.meta.toolCount === 60),
  );
  assert.equal(toolSet(60).length, 60);
  assert.equal(toolSet(2).length, 2);
  assert.equal(toolSet("agent").length, 20);
  assert.deepEqual(SUITE_NAMES.length, 6);
});

test(
  "reviewer suite needs a dataset or the product, and stratifies --limit",
  { skip: !product.reviewer },
  () => {
    const all = expandSuite(loadSuite("reviewer"), {
      model: "m",
      product,
      opts: {},
    });
    assert.ok(all.length > 100);
    const some = expandSuite(loadSuite("reviewer"), {
      model: "m",
      product,
      opts: { limit: 9 },
    });
    assert.equal(some.length, 9);
    assert.equal(new Set(some.map((c) => c.group)).size, 3);
    assert.ok(some[0].messages.at(-1).content.includes("Tool call to review"));
  },
);

test("report maths: rates, intervals, false calls, errors excluded", () => {
  const rec = (over) => ({
    suite: "s",
    kind: "dialect-probe",
    model: "m",
    mode: "native",
    group: "single-call",
    outcome: "structured",
    calls: [],
    recoveredBy: [],
    score: { valid: true, schemaValid: true, falseCall: false },
    usage: { outputTokens: 10 },
    ms: 100,
    ...over,
  });
  const records = [
    rec({}),
    rec({}),
    rec({
      score: { valid: false, schemaValid: true, falseCall: false },
      outcome: "prose",
    }),
    rec({ outcome: "error", score: null }),
    rec({
      group: "no-tool",
      expectNone: true,
      outcome: "structured",
      score: { valid: false, schemaValid: true, falseCall: true },
    }),
  ];
  const md = buildReport(records);
  assert.match(md, /5 records, 1 errors/);
  assert.match(md, /2\/4 = 50% \[15%, 85%\]/);
  assert.match(md, /1\/1 = 100%/);
});
