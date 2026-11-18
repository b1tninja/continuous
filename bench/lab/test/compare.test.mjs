import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCache } from "../lib/cache.mjs";
import {
  CompareError,
  MIN_PAIRS,
  compareRuns,
  formatCompare,
  mcnemarExact,
  pairedBootstrap,
} from "../lib/compare.mjs";
import { Budget } from "../lib/guards.mjs";
import { roots as makeRoots } from "../lib/paths.mjs";
import { probeThink, thinkRefusal } from "../lib/probe.mjs";
import {
  firstChanged,
  loadDumps,
  messagesForApi,
  normaliseRequest,
  replaySequences,
} from "../lib/replay.mjs";
import { buildArgs, readChatFormat } from "../lib/server.mjs";
import { Engine, parseMetrics, slimSlots } from "../lib/transports.mjs";
import { startFakeLlama } from "./fakeLlama.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lab-cmp-"));
const fresh = () => {
  const dir = tmp();
  return makeRoots({
    results: path.join(dir, "results"),
    profiles: path.join(dir, "profiles"),
    tmp: dir,
  });
};
const DUMPS = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  "..",
  "..",
  "tier0",
  "fixtures",
  "dumps",
);
const rec = (model, id, pass, valid) => ({
  suite: "dialect-probe",
  kind: "dialect-probe",
  model,
  caseId: id,
  pass,
  mode: "native",
  outcome: valid ? "structured" : "prose",
  score: { valid },
});
const arm = (model, n, validFn) =>
  Array.from({ length: n }, (_, i) =>
    rec(model, `c${i % 5}`, Math.floor(i / 5) + 1, validFn(i)),
  );

test("mcnemarExact: known values", () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(5, 5), 1);
  // b=0, c=10: 2 * 0.5^10
  assert.ok(Math.abs(mcnemarExact(0, 10) - 2 / 1024) < 1e-12);
  // b=2, c=8: 2 * (1 + 10 + 45) / 1024
  assert.ok(Math.abs(mcnemarExact(2, 8) - 112 / 1024) < 1e-12);
  assert.equal(mcnemarExact(3, 8), mcnemarExact(8, 3));
  assert.ok(mcnemarExact(500, 400) <= 1);
});

test("pairedBootstrap: reproducible, brackets the observed difference", () => {
  const d = [...Array(20).fill(1), ...Array(30).fill(0)];
  const a = pairedBootstrap(d);
  const b = pairedBootstrap(d);
  assert.deepEqual(a, b);
  assert.ok(a.lo < 0.4 && a.hi > 0.4 && a.lo > 0.1 && a.hi < 0.7);
  assert.equal(pairedBootstrap([]), undefined);
});

test("compare: under the minimum pairs there is no verdict, only rates", () => {
  const A = arm("m", 10, () => true);
  const B = arm("m", 10, () => false);
  const r = compareRuns(A, B);
  assert.equal(r.pairs, 10);
  assert.equal(r.enough, false);
  assert.match(r.verdict, /NOT ENOUGH PAIRS: 10 paired/);
  assert.match(r.verdict, new RegExp(`${MIN_PAIRS} are needed`));
  assert.equal(r.onlyA, 10);
  assert.doesNotMatch(r.verdict, /is better/);
});

test("compare: enough pairs, a clear gap is significant and the flips are listed", () => {
  const A = arm("llama", 50, () => true);
  const B = arm("ollama", 50, (i) => i % 5 !== 0); // 10 of 50 invalid
  const r = compareRuns(A, B);
  assert.equal(r.pairs, 50);
  assert.equal(r.onlyA, 10);
  assert.equal(r.onlyB, 0);
  assert.ok(r.p < 0.01);
  assert.match(r.verdict, /^A is better/);
  assert.equal(r.flipped.length, 10);
  const md = formatCompare(r, ["llama.jsonl", "ollama.jsonl"]);
  assert.match(md, /Cases that flipped \(10\)/);
  assert.match(md, /McNemar exact/);
  assert.match(md, /bootstrap/);
  // the 50 pairs are 5 prompts x 10 passes that agree: effective n is 5
  assert.match(md, /raw 40\/50, 5 prompts/);
  assert.match(md, /Effective n: 5\.0/);
  assert.match(r.verdict, /CAUTION: 50 raw pairs come from 5 distinct prompt/);
});

test("compare: an equal split of discordant pairs is not a difference", () => {
  const A = arm("a", 60, (i) => i % 4 !== 0);
  const B = arm("b", 60, (i) => i % 4 !== 1);
  const r = compareRuns(A, B);
  assert.equal(r.onlyA, 15);
  assert.equal(r.onlyB, 15);
  assert.equal(r.p, 1);
  assert.match(r.verdict, /^No detectable difference/);
});

test("compare: unpaired, errors and duplicates are counted not paired; several models need a choice", () => {
  const A = [...arm("m", 30, () => true), rec("m", "only-a", 1, true)];
  const B = [
    ...arm("n", 30, () => true),
    { ...rec("n", "c0", 9, true), outcome: "error", score: null },
    rec("n", "c0", 1, false),
  ];
  const r = compareRuns(A, B);
  assert.equal(r.pairs, 30);
  assert.equal(r.unpaired.a, 1);
  assert.equal(r.errors.b, 1);
  assert.equal(r.duplicates.b, 1);
  assert.throws(
    () => compareRuns([...A, rec("x", "c0", 1, true)], B),
    (e) =>
      e instanceof CompareError && /pick one with --model-a/.test(e.message),
  );
  const picked = compareRuns([...A, rec("x", "c0", 1, true)], B, {
    modelA: "m",
  });
  assert.equal(picked.pairs, 30);
  assert.throws(() => compareRuns(A, B, { modelB: "zzz" }), CompareError);
});

test("compare CLI: two files, a verdict on stdout", async () => {
  const { main } = await import("../lab.mjs");
  const dir = tmp();
  const wr = (n, recs) =>
    fs.writeFileSync(
      path.join(dir, n),
      recs.map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
  wr(
    "a.jsonl",
    arm("m", 8, () => true),
  );
  wr(
    "b.jsonl",
    arm("m", 8, (i) => i > 2),
  );
  let out = "";
  const w = process.stdout.write;
  process.stdout.write = (s) => ((out += s), true);
  try {
    await main([
      "compare",
      path.join(dir, "a.jsonl"),
      path.join(dir, "b.jsonl"),
    ]);
  } finally {
    process.stdout.write = w;
  }
  assert.match(out, /# Lab compare: a.jsonl vs b.jsonl/);
  assert.match(out, /NOT ENOUGH PAIRS: 8 paired/);
});

test("server: Chat format line is read from the log, --metrics and --slots are passed", () => {
  const dir = tmp();
  const log = path.join(dir, "s.log");
  fs.writeFileSync(
    log,
    "# cmd\nload\nsrv  init: Chat format: Generic\nlater: Chat format: Hermes 2 Pro\n",
  );
  assert.equal(readChatFormat(log), "Hermes 2 Pro");
  assert.equal(readChatFormat(path.join(dir, "none.log")), undefined);
  const a = buildArgs({ gguf: "m.gguf", metrics: true, slots: true });
  assert.ok(a.includes("--metrics") && a.includes("--slots"));
  assert.ok(!buildArgs({ gguf: "m.gguf" }).includes("--metrics"));
});

test("describe: llama-server records Chat format from the log and the /props template hash; /slots is the fallback", async () => {
  const fake = await startFakeLlama();
  const dir = tmp();
  const log = path.join(dir, "s.log");
  fs.writeFileSync(log, "x\nChat format: Qwen3 Coder\n");
  try {
    const e = new Engine({
      api: "openai-chat",
      baseUrl: fake.url,
      serverLog: log,
    });
    const d = await e.describe("m");
    assert.equal(d.chatFormat, "Qwen3 Coder");
    assert.equal(d.chatFormatSource, "log");
    assert.match(d.chatTemplateSha, /^[0-9a-f]{16}$/);
    const e2 = new Engine({ api: "openai-chat", baseUrl: fake.url });
    const d2 = await e2.describe("m");
    assert.equal(d2.chatFormat, "Content-only");
    assert.equal(d2.chatFormatSource, "slots");
    assert.equal(d2.chatTemplateSha, d.chatTemplateSha);
  } finally {
    await fake.close();
  }
});

test("sidecar: /slots and /metrics are parsed and polled after each request", async () => {
  assert.deepEqual(
    parseMetrics(
      "# HELP x\nllamacpp:prompt_tokens_total 42\nllamacpp:n_tokens_max 7\nother 1\n",
    ),
    { prompt_tokens_total: 42, n_tokens_max: 7 },
  );
  const slim = slimSlots([
    { id: 0, n_ctx: 1, params: { a: 1 }, next_token: { n: 1 } },
  ]);
  assert.deepEqual(slim, [{ id: 0, n_ctx: 1, next_token: { n: 1 } }]);
  const fake = await startFakeLlama();
  try {
    const e = new Engine({
      api: "openai-chat",
      baseUrl: fake.url,
      sidecar: { slots: true, metrics: true },
    });
    const r = await e.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      api: "openai-chat",
    });
    assert.equal(r.sidecar.slots[0].n_ctx, 16384);
    assert.equal(r.sidecar.slots[0].params, undefined);
    assert.ok(r.sidecar.metrics.prompt_tokens_total >= 10);
    const plain = new Engine({ api: "openai-chat", baseUrl: fake.url });
    const r2 = await plain.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      api: "openai-chat",
    });
    assert.equal(r2.sidecar, undefined);
  } finally {
    await fake.close();
  }
});

const refuseThink = (body) =>
  body.chat_template_kwargs
    ? { status: 400, error: '"m" does not support thinking' }
    : { content: "OK" };

test("think probe: a refusal fails loudly with the engine's message and records nothing", async () => {
  const fake = await startFakeLlama({ script: refuseThink });
  const roots = fresh();
  const logs = [];
  try {
    const client = new Engine({ api: "openai-chat", baseUrl: fake.url });
    const cfg = { api: "openai-chat", think: "off" };
    const p = await probeThink({ client, model: "m", cfg });
    assert.equal(p.ok, false);
    assert.match(thinkRefusal("m", p), /does not support thinking/);
    assert.deepEqual(
      await probeThink({ client, model: "m", cfg: { api: "openai-chat" } }),
      {
        skipped: true,
      },
    );
    const s = await runCache({
      client,
      suite: {
        defaults: { temperature: 0, numPredict: 16 },
        system: "s",
        prompts: ["a", "b"],
      },
      models: [
        { name: "m", size: 1e9, capabilities: ["tools"], family: "gguf" },
      ],
      roots,
      budget: new Budget({ maxRequests: 50 }),
      log: (l) => logs.push(l),
      facts: {},
      limits: { maxVramGB: 8, maxRamGB: 16 },
      cfg,
    });
    assert.match(
      s.stopped,
      /--think off was refused .* does not support thinking/,
    );
    assert.equal(s.ran, 0);
    assert.equal(s.errors, 0);
    assert.ok(!fs.existsSync(s.file));
    assert.ok(logs.some((l) => /REFUSED/.test(l)));
  } finally {
    await fake.close();
  }
});

test("think probe: an accepting engine passes and the record says so", async () => {
  const fake = await startFakeLlama();
  const roots = fresh();
  try {
    const client = new Engine({ api: "openai-chat", baseUrl: fake.url });
    const s = await runCache({
      client,
      suite: {
        defaults: { temperature: 0, numPredict: 16 },
        system: "s",
        prompts: ["a", "b"],
      },
      models: [
        { name: "m", size: 1e9, capabilities: ["tools"], family: "gguf" },
      ],
      roots,
      budget: new Budget({ maxRequests: 50 }),
      facts: {},
      limits: { maxVramGB: 8, maxRamGB: 16 },
      cfg: { api: "openai-chat", think: "off" },
    });
    assert.equal(s.ran, 14);
    const first = JSON.parse(fs.readFileSync(s.file, "utf8").split("\n")[0]);
    assert.equal(first.engine.thinkProbe, "accepted");
  } finally {
    await fake.close();
  }
});

test("replay: loads the three fixture sets (11 requests), normalises and prefixes a nonce", () => {
  const sets = loadDumps(DUMPS);
  assert.deepEqual(
    sets.map((s) => [s.id, s.requests.length]),
    [
      ["churn", 5],
      ["extends", 4],
      ["system-field", 2],
    ],
  );
  const sf = sets.find((s) => s.id === "system-field");
  assert.equal(sf.requests[0].messages[0].role, "system");
  const seqs = replaySequences(sets, { nonce: "n1", api: "ollama-chat" });
  assert.ok(seqs[0].steps[0].messages[0].content.startsWith("[replay n1]\n"));
  assert.equal(seqs[0].steps[0].firstChanged, undefined);
  assert.ok(seqs[0].steps[1].firstChanged > 0);
  assert.equal(firstChanged("abcd", "abxd"), 2);
  assert.throws(() => normaliseRequest({ nope: 1 }), /no messages/);
  const o = messagesForApi(
    [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c", function: { name: "f", arguments: '{"a":1}' } },
        ],
      },
    ],
    "ollama-chat",
  );
  assert.deepEqual(o[0].tool_calls[0].function.arguments, { a: 1 });
});

test("replay: a jsonl of segment-dump lines is read, extra fields kept", () => {
  const dir = tmp();
  const f = path.join(dir, "seg.jsonl");
  fs.writeFileSync(
    f,
    [
      {
        first_changed_vs_prev: null,
        request: { messages: [{ role: "user", content: "a" }] },
      },
      {
        first_changed_vs_prev: 3,
        request: { messages: [{ role: "user", content: "ab" }] },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
  const [set] = loadDumps(f);
  assert.equal(set.requests.length, 2);
  assert.equal(set.requests[1].source.first_changed_vs_prev, 3);
});

test("replay CLI: sends every dump through the cache path and reports cached/evaluated per request", async () => {
  const { main } = await import("../lab.mjs");
  const fake = await startFakeLlama();
  const dir = tmp();
  const gguf = path.join(dir, "tiny.gguf");
  fs.writeFileSync(gguf, Buffer.alloc(1000));
  try {
    await main([
      "replay",
      "--run",
      "--dumps",
      DUMPS,
      "--api",
      "openai-chat",
      "--base-url",
      fake.url,
      "--gguf",
      gguf,
      "--ollama-url",
      "http://127.0.0.1:1",
      "--out",
      path.join(dir, "out"),
      "--cooldown",
      "0",
      "--slots",
      "--metrics",
    ]);
    const recs = fs
      .readFileSync(path.join(dir, "out", "replay.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(recs.length, 11);
    assert.ok(recs.every((r) => r.suite === "replay" && r.kind === "cache"));
    assert.ok(recs.every((r) => r.usage.promptTokens > 0));
    assert.ok(recs.some((r) => r.usage.cachedTokens > 0));
    assert.ok(recs.every((r) => r.sidecar?.metrics && r.sidecar.slots));
    const { buildCacheReport } = await import("../lib/cache.mjs");
    const md = buildCacheReport(recs);
    assert.match(md, /## churn: /);
    assert.match(md, /first changed char/);
    assert.match(md, /slot \/ metrics/);
  } finally {
    await fake.close();
  }
});
