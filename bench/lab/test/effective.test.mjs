// Effective n, `--temperature inherit`, per-pass seeds and the /props chat
// format: pure maths plus the fake servers. No model, no GPU.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProduct } from "../adapter.mjs";
import { main } from "../lab.mjs";
import { runCache } from "../lib/cache.mjs";
import { compareRuns, formatCompare, tempOf } from "../lib/compare.mjs";
import { Budget, machineFacts } from "../lib/guards.mjs";
import { roots as makeRoots } from "../lib/paths.mjs";
import { buildReport } from "../lib/report.mjs";
import { validateResult } from "../lib/resultSchema.mjs";
import { readRecords, resultFile } from "../lib/results.mjs";
import { makePlan, runSuite, sampleSize } from "../lib/run.mjs";
import {
  chatFormatFromProps,
  llamaSamplingDefaults,
  mergeBodyExtra,
  parseModelfileParameters,
  samplingSent,
  seedFor,
  temperatureToSend,
} from "../lib/sampling.mjs";
import {
  effectiveCounts,
  effectiveRate,
  fmtRate,
  wilson,
} from "../lib/stats.mjs";
import { loadSuite } from "../lib/suites.mjs";
import { buildProfile } from "../lib/suggest.mjs";
import { buildRequest, Engine } from "../lib/transports.mjs";
import { startFakeLlama } from "./fakeLlama.mjs";
import { SMALL, startFake } from "./fakeOllama.mjs";

const product = await loadProduct();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lab-eff-"));
const fresh = () => {
  const dir = tmp();
  return makeRoots({
    results: path.join(dir, "results"),
    profiles: path.join(dir, "profiles"),
    tmp: dir,
  });
};
const FACTS = machineFacts({
  exec: () => {
    throw new Error("none");
  },
});
const LIMITS = { maxVramGB: 8, maxRamGB: 16 };
const model = (m) => ({
  name: m.name,
  size: m.size,
  capabilities: m.capabilities,
  family: m.family,
});

/** 8 prompts x `passes`, valid per `validFn(prompt, pass)`, at temperature `t`. */
const recs = (passes, validFn, t = 0, extra = {}) =>
  Array.from({ length: 8 * passes }, (_, i) => {
    const prompt = i % 8;
    const pass = Math.floor(i / 8) + 1;
    const valid = validFn(prompt, pass);
    return {
      suite: "leaks",
      kind: "leaks",
      model: "m",
      caseId: `p${prompt}`,
      pass,
      stream: false,
      temperature: t,
      meta: { toolCount: 2 },
      mode: "native",
      outcome: valid ? "structured" : "prose",
      calls: [],
      recoveredBy: [],
      score: { valid, schemaValid: valid, falseCall: false },
      usage: { outputTokens: 5 },
      ms: 10,
      ...extra,
    };
  });

const mixedValid = (p, pass) => (p * 3 + pass * 5) % 2 === 0;

test("effective n: 8 prompts x 3 identical passes is n = 8, not 24", () => {
  const e = effectiveRate(
    recs(3, (p) => p < 6),
    (r) => r.score.valid,
  );
  assert.equal(e.rawN, 24);
  assert.equal(e.rawK, 18);
  assert.equal(e.units, 8);
  assert.equal(e.n, 8);
  assert.ok(e.repeats);
  assert.ok(Math.abs(e.k - 6) < 1e-9);
  // the interval is the Wilson interval of 6/8, not of 18/24
  const w8 = wilson(6, 8);
  assert.ok(Math.abs(e.lo - w8.lo) < 1e-12 && Math.abs(e.hi - w8.hi) < 1e-12);
  const w24 = wilson(18, 24);
  assert.ok(e.hi - e.lo > w24.hi - w24.lo);
  assert.equal(fmtRate(e), "6/8 = 75% [41%, 93%] (raw 18/24, 8 prompts)");
});

test("effective n: one pass is the raw n; passes that disagree sit between prompts and requests", () => {
  const one = effectiveRate(
    recs(1, (p) => p < 6),
    (r) => r.score.valid,
  );
  assert.equal(one.n, 8);
  assert.equal(fmtRate(one), "6/8 = 75% [41%, 93%]");
  const e = effectiveRate(recs(4, mixedValid), (r) => r.score.valid);
  assert.equal(e.rawN, 32);
  assert.equal(e.units, 8);
  assert.ok(!e.repeats);
  assert.ok(e.n > 8 && e.n <= 32, `n_eff ${e.n}`);
  // prompts that differ in difficulty while their passes agree: fully clustered
  assert.equal(
    effectiveCounts([
      { m: 4, s: 4 },
      { m: 4, s: 0 },
    ]).n,
    2,
  );
  assert.equal(effectiveCounts([]).n, 0);
  // a record with no prompt identity is its own unit
  const anon = effectiveRate(
    [{ score: { valid: true } }, { score: { valid: true } }],
    (r) => r.score.valid,
  );
  assert.equal(anon.n, 2);
});

test("report: raw and effective n side by side, intervals on the effective n, REPEATS line at temperature 0", () => {
  const md = buildReport(recs(3, (p) => p < 6));
  assert.match(md, /n raw \| n effective/);
  assert.match(
    md,
    /\| 24 \| 8 \| 6\/8 = 75% \[41%, 93%\] \(raw 18\/24, 8 prompts\)/,
  );
  assert.match(md, /REPEATS: the passes of every repeated prompt agreed/);
  assert.doesNotMatch(buildReport(recs(4, mixedValid)), /REPEATS:/);
});

test("suggest: min-n and the bars use the effective n", () => {
  const rs = recs(3, (p) => p < 6);
  const p = buildProfile("m", rs, { minN: 10 });
  assert.equal(p.best, null, "8 prompts x 3 passes is not 10 per arm");
  const p8 = buildProfile("m", rs, { minN: 8 });
  assert.equal(p8.best.n, 8);
  assert.equal(p8.best.k, 6);
  assert.equal(p8.best.rawN, 24);
  assert.equal(p8.native.n, 8);
  assert.equal(p8.native.rawN, 24);
});

test("sampleSize and plan: n is the prompt count at temperature 0, unknown when inherited", () => {
  const cases = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    temperature: 0,
  }));
  const t0 = sampleSize(cases, 3, { api: "ollama-chat" });
  assert.equal(t0.effN, 8);
  assert.equal(t0.rawN, 24);
  assert.match(t0.nNote, /repeat the same output, so n is 8 prompts, not 24/);
  assert.equal(sampleSize(cases, 1, {}).effN, 8);
  const inh = sampleSize(cases, 3, { temperature: "inherit" });
  assert.equal(inh.effN, undefined);
  assert.match(inh.nNote, /inherited/);
  const hot = sampleSize(cases, 4, { temperature: 0.6, seed: 1 });
  assert.equal(hot.effN, undefined);
  assert.match(hot.nNote, /between 8 prompts and 32 passes/);
  const plan = makePlan({
    suite: loadSuite("dialect-probe"),
    models: [model(SMALL)],
    passes: 3,
    opts: { styles: "codeblock" },
    product,
    history: [],
  })[0];
  assert.equal(plan.prompts, 12);
  assert.equal(plan.rawN, 36);
  assert.equal(plan.effN, 12);
});

test("compare: temperature 0 passes pair at the prompt level (auto), both levels are printed", () => {
  const A = recs(3, () => true, 0);
  const B = recs(3, (p) => p !== 2 && p !== 3, 0);
  const r = compareRuns(A, B);
  assert.equal(r.unit, "prompt");
  assert.equal(r.pairs, 8);
  assert.equal(r.raw.pairs, 24);
  assert.equal(r.raw.prompts, 8);
  assert.equal(r.raw.onlyA, 6);
  assert.equal(r.onlyA, 2);
  assert.equal(r.byPrompt.p, r.p);
  assert.match(r.verdict, /NOT ENOUGH PAIRS: 8 prompt\(s\)/);
  assert.equal(r.flipped.length, 2);
  assert.equal(r.flipped[0].passes, 3);
  const md = formatCompare(r, ["a", "b"]);
  assert.match(
    md,
    /Raw n: 24 paired result\(s\)\. Distinct prompts: 8\. Effective n: 8\.0/,
  );
  assert.match(md, /per pass \(raw n\) \| 24/);
  assert.match(md, /per prompt \(effective n at temperature 0\) \| 8/);
  assert.match(md, /cluster bootstrap 95% interval/);
  assert.match(md, /over 3 pass\(es\)/);
  // the pass level is still available
  const pass = compareRuns(A, B, { unit: "pass" });
  assert.equal(pass.unit, "pass");
  assert.equal(pass.pairs, 24);
  assert.match(pass.verdict, /Passes at temperature 0 repeat/);
  assert.equal(compareRuns(A, B, { unit: "prompt" }).pairs, 8);
  assert.throws(() => compareRuns(A, B, { unit: "x" }), /unit must be one of/);
});

test("compare: above temperature 0 the pass level stays, with the effective n and a caution", () => {
  const A = recs(4, () => true, 0.6);
  const B = recs(4, (p) => p > 1, 0.6);
  // 8 prompts x 4 passes = 32 raw pairs: enough raw, but 8 independent
  const r = compareRuns(A, B);
  assert.equal(r.unit, "pass");
  assert.equal(r.pairs, 32);
  assert.match(r.verdict, /CAUTION: 32 raw pairs come from 8 distinct prompt/);
  assert.equal(r.rateB.rawN, 32);
  assert.equal(r.rateB.units, 8);
  assert.equal(r.rateB.n, 8);
});

test("compare: a prompt that splits evenly on a side is left out of the prompt level and named", () => {
  const A = recs(2, () => true, 0);
  const B = recs(2, (p, pass) => (p === 0 ? pass === 1 : true), 0);
  const r = compareRuns(A, B);
  assert.equal(r.byPrompt.unstable, 1);
  assert.deepEqual(r.byPrompt.unstableCases, ["p0"]);
  assert.equal(r.pairs, 7);
  assert.match(formatCompare(r), /left out of the prompt level.*p0/);
});

test("compare accepts runs that sent no temperature", () => {
  const rs = recs(2, () => true, "inherited", {
    sampling: { temperature: "inherited" },
  });
  assert.equal(tempOf(rs[0]), "inherited");
  const r = compareRuns(rs, rs);
  assert.equal(r.unit, "pass");
  assert.equal(r.pairs, 16);
  assert.equal(r.temperature0, false);
});

test("compare CLI: --unit is honoured", async () => {
  const dir = tmp();
  const wr = (n, rs) =>
    fs.writeFileSync(
      path.join(dir, n),
      rs.map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
  wr(
    "a.jsonl",
    recs(3, () => true),
  );
  wr(
    "b.jsonl",
    recs(3, (p) => p > 0),
  );
  const capture = async (args) => {
    let out = "";
    const w = process.stdout.write;
    process.stdout.write = (s) => ((out += s), true);
    try {
      await main(args);
    } finally {
      process.stdout.write = w;
    }
    return out;
  };
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  assert.match(await capture(["compare", a, b]), /NOT ENOUGH PAIRS: 8 prompt/);
  assert.match(
    await capture(["compare", a, b, "--unit", "pass"]),
    /NOT ENOUGH PAIRS: 24 paired/,
  );
});

test("sampling helpers: inherit sends nothing, seeds are per pass, body-extra merges options", () => {
  assert.equal(temperatureToSend({ temperature: "inherit" }, 0), undefined);
  assert.equal(temperatureToSend({ temperature: 0.6 }, 0), 0.6);
  assert.equal(temperatureToSend({}, 0), 0);
  assert.equal(seedFor({ seed: 10 }, 3), 12);
  assert.equal(seedFor({}, 3), undefined);
  const body = { options: { temperature: 0, num_predict: 64 }, model: "m" };
  mergeBodyExtra(body, { options: { top_p: 0.95 }, think: false });
  assert.deepEqual(body.options, {
    temperature: 0,
    num_predict: 64,
    top_p: 0.95,
  });
  assert.equal(body.think, false);
  assert.deepEqual(
    parseModelfileParameters(
      'temperature 1\ntop_k 20\nstop "<|im_end|>"\nstop "<|im_start|>"\npresence_penalty 1.5',
    ),
    {
      temperature: 1,
      top_k: 20,
      stop: ["<|im_end|>", "<|im_start|>"],
      presence_penalty: 1.5,
    },
  );
  assert.equal(parseModelfileParameters(""), undefined);
  assert.equal(parseModelfileParameters(undefined), undefined);
  assert.deepEqual(
    llamaSamplingDefaults({
      default_generation_settings: {
        params: { temperature: 0.8, top_k: 40, n_predict: -1 },
      },
    }),
    { temperature: 0.8, top_k: 40 },
  );
  assert.equal(llamaSamplingDefaults({}), undefined);
  assert.equal(
    chatFormatFromProps({ chat_format: "Hermes 2 Pro" }),
    "Hermes 2 Pro",
  );
  assert.equal(
    chatFormatFromProps({
      default_generation_settings: { params: { chat_format: "Generic" } },
    }),
    "Generic",
  );
  assert.equal(chatFormatFromProps({}), undefined);
});

test("buildRequest: inherit leaves every sampling option out on every surface, keeps the caps", () => {
  const base = {
    model: "m",
    messages: [{ role: "user", content: "x" }],
    numPredict: 64,
    numCtx: 4096,
  };
  for (const api of ["ollama-chat", "ollama-v1", "openai-chat"]) {
    const { body } = buildRequest(api, { ...base, temperature: undefined });
    const wire = body.options ?? body;
    assert.ok(!("temperature" in wire), api);
    assert.ok(!("seed" in wire), api);
    assert.equal(samplingSent(api, body).temperature, "inherited");
    assert.ok(samplingSent(api, body).inherited.includes("top_p"));
  }
  const chat = buildRequest("ollama-chat", {
    ...base,
    bodyExtra: { options: { top_p: 0.9 } },
  }).body;
  assert.deepEqual(chat.options, {
    num_predict: 64,
    num_ctx: 4096,
    top_p: 0.9,
  });
  const s = samplingSent("ollama-chat", chat);
  assert.equal(s.topP, 0.9);
  assert.equal(s.maxTokens, 64);
  assert.ok(!s.inherited.includes("top_p") && s.inherited.includes("top_k"));
});

const engineFor = (api, url) =>
  new Engine({ api, baseUrl: url, requestTimeoutMs: 2000 });

test("run --temperature inherit: no sampling option on the wire, the record says inherited and holds the Modelfile parameters; seeds go per pass", async () => {
  const withParams = {
    ...SMALL,
    parameters:
      'temperature 1\ntop_k 20\npresence_penalty 1.5\nstop "<|im_end|>"',
  };
  const fake = await startFake({ models: [withParams] });
  const roots = fresh();
  try {
    const summary = await runSuite({
      client: engineFor("ollama-chat", fake.url),
      product,
      suite: loadSuite("dialect-probe"),
      models: [model(withParams)],
      passes: 2,
      opts: { styles: "codeblock", limit: 2 },
      roots,
      budget: new Budget({ maxRequests: 100 }),
      facts: FACTS,
      limits: LIMITS,
      cfg: { api: "ollama-chat", temperature: "inherit", seed: 10 },
    });
    assert.equal(summary.errors, 0);
    const sent = fake.state.chats;
    assert.ok(sent.length >= 4);
    for (const b of sent) {
      assert.ok(!("temperature" in b.options), JSON.stringify(b.options));
      assert.ok(b.options.num_predict > 0);
    }
    assert.deepEqual(
      [...new Set(sent.map((b) => b.options.seed))].sort(),
      [10, 11],
    );
    const rs = readRecords(resultFile(roots, "dialect-probe"));
    assert.ok(rs.length >= 4);
    for (const r of rs) {
      assert.equal(r.temperature, "inherited");
      assert.equal(r.cfg.temperature, "inherited");
      assert.equal(r.sampling.temperature, "inherited");
      assert.equal(r.sampling.seed, 10 + r.pass - 1);
      assert.ok(r.sampling.inherited.includes("top_p"));
      assert.equal(r.sampling.serverDefaults.temperature, 1);
      assert.equal(r.sampling.serverDefaults.presence_penalty, 1.5);
      assert.match(r.key, /@t=inherit,seed=10\|p\d$/);
    }
    assert.equal(rs[0].engine.parameters.stop, "<|im_end|>");
    // compare accepts the inherited runs
    const c = compareRuns(rs, rs);
    assert.equal(c.pairs, rs.filter((r) => r.score).length);
  } finally {
    await fake.close();
  }
});

test("an explicit temperature is recorded as sent", async () => {
  const fake = await startFake();
  const roots = fresh();
  try {
    await runSuite({
      client: engineFor("ollama-chat", fake.url),
      product,
      suite: loadSuite("dialect-probe"),
      models: [model(SMALL)],
      passes: 1,
      opts: { styles: "codeblock", limit: 1 },
      roots,
      budget: new Budget({ maxRequests: 100 }),
      facts: FACTS,
      limits: LIMITS,
      cfg: { api: "ollama-chat", temperature: 0.6 },
    });
    const rs = readRecords(resultFile(roots, "dialect-probe"));
    assert.ok(rs.length > 0);
    for (const r of rs) {
      assert.equal(r.sampling.temperature, 0.6);
      assert.ok(!r.sampling.inherited.includes("temperature"));
      assert.equal(r.temperature, 0.6);
    }
    assert.ok(fake.state.chats.every((b) => b.options.temperature === 0.6));
  } finally {
    await fake.close();
  }
});

test("the result schema accepts the sampling the lab records", () => {
  const sha = "a".repeat(64);
  const rec = {
    schemaVersion: 1,
    runId: "r",
    labSha: "abc1234",
    productSha: "def5678",
    contractVersion: 2,
    arm: {
      model: "qwen3.6:27b",
      declaredQuant: "Q4_K_M",
      provider: "ollama",
      engine: "ollama 0.40",
      apiSurface: "ollama-chat",
      clientPath: "lab/transports",
      sampling: {
        temperature: "inherited",
        inherited: ["temperature", "top_p"],
        serverDefaults: { temperature: 1, presence_penalty: 1.5 },
        presencePenalty: 0,
        seed: 3,
      },
    },
    request: { sha256: sha },
    reply: { sha256: sha },
    usage: {},
    classification: { outcome: "structured", dialect: "native-structured" },
    scanStatus: "unscanned",
  };
  assert.deepEqual(validateResult(rec), []);
  rec.arm.sampling.inherited = "all";
  assert.match(validateResult(rec).join("\n"), /inherited: must be array/);
});

test("replay with --temperature inherit sends no temperature and records it", async () => {
  const fake = await startFakeLlama();
  const dir = tmp();
  const gguf = path.join(dir, "tiny.gguf");
  fs.writeFileSync(gguf, Buffer.alloc(1000));
  try {
    await main([
      "replay",
      "--run",
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
      "--temperature",
      "inherit",
    ]);
    const bodies = fake.state.requests.filter((b) => b.messages);
    assert.ok(bodies.length >= 11);
    assert.ok(bodies.every((b) => !("temperature" in b) && b.max_tokens > 0));
    const rs = fs
      .readFileSync(path.join(dir, "out", "replay.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(rs.every((r) => r.sampling.temperature === "inherited"));
    assert.ok(rs.every((r) => r.cfg.temperature === "inherit"));
  } finally {
    await fake.close();
  }
});

test("cli: --temperature inherit refuses a --temperatures grid; the plan prints raw and effective n", async () => {
  const fake = await startFake();
  const dir = tmp();
  const base = [
    "--base-url",
    fake.url,
    "--results-dir",
    path.join(dir, "r"),
    "--profiles-dir",
    path.join(dir, "p"),
  ];
  const err = [];
  const orig = process.stderr.write;
  const origExit = process.exit;
  process.stderr.write = (s) => (err.push(String(s)), true);
  try {
    process.exit = (c) => {
      throw new Error(`exit ${c}`);
    };
    await assert.rejects(
      main([
        "plan",
        "--suite",
        "leaks",
        "--models",
        SMALL.name,
        "--temperature",
        "inherit",
        "--temperatures",
        "0,0.7",
        ...base,
      ]),
      /exit 2/,
    );
    assert.match(err.join(""), /give one value/);
    process.exit = origExit;
    err.length = 0;
    const plan = (...more) =>
      main([
        "plan",
        "--suite",
        "dialect-probe",
        "--models",
        SMALL.name,
        "--passes",
        "3",
        "--styles",
        "codeblock",
        ...more,
        ...base,
      ]);
    await plan();
    assert.match(
      err.join(""),
      /36 raw n, effective n 12; temperature 0: the 3 passes repeat the same output/,
    );
    err.length = 0;
    await plan("--temperature", "inherit");
    assert.match(
      err.join(""),
      /effective n estimated after the run; temperature inherited/,
    );
  } finally {
    process.exit = origExit;
    process.stderr.write = orig;
    await fake.close();
  }
});

test("describe: llama-server reads the chat format from /props first, the log second", async () => {
  const fake = await startFakeLlama({
    props: {
      chat_format: "Qwen3 Coder",
      default_generation_settings: {
        n_ctx: 16384,
        params: { temperature: 0.8, top_k: 40 },
      },
    },
  });
  const dir = tmp();
  const log = path.join(dir, "s.log");
  fs.writeFileSync(log, "x\nChat format: Generic\n");
  try {
    const d = await new Engine({
      api: "openai-chat",
      baseUrl: fake.url,
      serverLog: log,
    }).describe("m");
    assert.equal(d.chatFormat, "Qwen3 Coder");
    assert.equal(d.chatFormatSource, "props");
    assert.deepEqual(d.samplingDefaults, { temperature: 0.8, top_k: 40 });
  } finally {
    await fake.close();
  }
  // a build like b12206: no chat format in /props and no log line: /slots
  const bare = await startFakeLlama();
  try {
    const d = await new Engine({
      api: "openai-chat",
      baseUrl: bare.url,
    }).describe("m");
    assert.equal(d.chatFormatSource, "slots");
  } finally {
    await bare.close();
  }
});

test("cache runner with inherit: the llama request carries no temperature", async () => {
  const fake = await startFakeLlama();
  const roots = fresh();
  try {
    await runCache({
      client: engineFor("openai-chat", fake.url),
      suite: { defaults: { temperature: 0, numPredict: 8 } },
      suiteName: "cache",
      buildSequences: () => [
        {
          id: "s",
          arm: "a",
          steps: [
            {
              label: "one",
              messages: [{ role: "user", content: "hi" }],
              tools: [],
            },
          ],
        },
      ],
      models: [
        { name: "fake", size: 1e6, capabilities: ["tools"], family: "gguf" },
      ],
      roots,
      budget: new Budget({ maxRequests: 5 }),
      log: () => {},
      facts: { ...FACTS, gpus: undefined },
      limits: LIMITS,
      cfg: { api: "openai-chat", temperature: "inherit" },
      cooldownMs: 0,
    });
    const body = fake.state.requests.find((b) => b.messages);
    assert.ok(!("temperature" in body));
    const rs = readRecords(resultFile(roots, "cache"));
    assert.equal(rs[0].sampling.temperature, "inherited");
  } finally {
    await fake.close();
  }
});
