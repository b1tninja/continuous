import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProduct } from "../adapter.mjs";
import { main } from "../lab.mjs";
import { diffArms, formatDiff } from "../lib/diff.mjs";
import { writeFixtures } from "../lib/fixtures.mjs";
import { Budget, machineFacts } from "../lib/guards.mjs";
import { inventory } from "../lib/inventory.mjs";
import { LabError, OllamaClient } from "../lib/ollama.mjs";
import { roots as makeRoots } from "../lib/paths.mjs";
import { buildReport } from "../lib/report.mjs";
import { readRecords, resultFile } from "../lib/results.mjs";
import { makePlan, runSuite } from "../lib/run.mjs";
import { loadSuite } from "../lib/suites.mjs";
import { buildProfile, writeProfiles } from "../lib/suggest.mjs";
import { BIG, SMALL, startFake } from "./fakeOllama.mjs";

const product = await loadProduct();
const LIMITS = { maxVramGB: 8, maxRamGB: 16 };
const FACTS = machineFacts({
  exec: () => {
    throw new Error("none");
  },
});
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-run-"));
  return makeRoots({
    results: path.join(dir, "results"),
    profiles: path.join(dir, "profiles"),
    tmp: dir,
  });
};
const model = (m) => ({
  name: m.name,
  size: m.size,
  capabilities: m.capabilities,
  family: m.family,
});

async function setup(opts) {
  const fake = await startFake(opts);
  const client = new OllamaClient({
    baseUrl: fake.url,
    requestTimeoutMs: 2000,
  });
  return { fake, client, roots: fresh() };
}

const run = (ctx, extra = {}) =>
  runSuite({
    client: ctx.client,
    product,
    suite: loadSuite("dialect-probe"),
    models: [model(SMALL)],
    roots: ctx.roots,
    budget: new Budget({ maxRequests: 100 }),
    facts: FACTS,
    limits: LIMITS,
    opts: { styles: "codeblock" },
    ...extra,
  });

test("client: non-streaming and streaming replies, tool calls and text", async () => {
  const { fake, client } = await setup();
  try {
    const whole = await client.chat({
      model: SMALL.name,
      messages: [{ role: "user", content: "Read the file a.txt." }],
      tools: [{ name: "read_file", parameters: {} }],
    });
    assert.deepEqual(whole.toolCalls, [
      { name: "read_file", arguments: '{"path":"a.txt"}' },
    ]);
    assert.equal(whole.usage.outputTokens, 20);
    const s = await client.chat({
      model: SMALL.name,
      messages: [{ role: "user", content: "capital?" }],
      stream: true,
    });
    assert.equal(s.text, "Paris");
    assert.equal(s.chunks.join(""), "Paris");
    const st = await client.chat({
      model: SMALL.name,
      messages: [{ role: "user", content: "Read the file b.txt." }],
      tools: [{ name: "read_file" }],
      stream: true,
    });
    assert.equal(st.toolCalls[0].name, "read_file");
  } finally {
    await fake.close();
  }
});

test("client: timeout, http error and abort become LabErrors", async () => {
  const slow = await startFake({ delayMs: 400 });
  try {
    const c = new OllamaClient({ baseUrl: slow.url, requestTimeoutMs: 50 });
    await assert.rejects(
      c.chat({ model: "x", messages: [] }),
      (e) => e instanceof LabError && e.kind === "timeout",
    );
    const ctl = new AbortController();
    const c2 = new OllamaClient({
      baseUrl: slow.url,
      requestTimeoutMs: 5000,
      signal: ctl.signal,
    });
    const p = c2.chat({ model: "x", messages: [] });
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(p, (e) => e.kind === "aborted");
  } finally {
    await slow.close();
  }
  const bad = await startFake({
    script: () => ({ status: 500, error: "kaput" }),
  });
  try {
    await assert.rejects(
      new OllamaClient({ baseUrl: bad.url }).chat({ model: "x", messages: [] }),
      /HTTP 500/,
    );
  } finally {
    await bad.close();
  }
  assert.throws(
    () => new OllamaClient({ baseUrl: "http://192.0.2.1:11434" }),
    /non-loopback/,
  );
});

test("run: records every case, text mode sends no tools field, model is unloaded", async () => {
  const ctx = await setup();
  try {
    const summary = await run(ctx);
    assert.equal(summary.ran, 12);
    assert.equal(summary.errors, 0);
    const recs = readRecords(resultFile(ctx.roots, "dialect-probe"));
    assert.equal(recs.length, 12);
    const native = recs.find((r) => r.caseId === "native-call.native");
    assert.equal(native.outcome, "structured");
    assert.equal(native.score.valid, true);
    const text = recs.find((r) => r.caseId === "native-call.text-codeblock");
    assert.equal(text.outcome, "prose");
    assert.equal(text.score.valid, false);
    const sent = ctx.fake.state.chats;
    assert.equal(sent.filter((b) => b.tools).length, 6);
    assert.equal(sent.filter((b) => !b.tools).length, 6);
    assert.ok(
      sent
        .filter((b) => !b.tools)
        .every((b) => b.messages[0].content.includes("TOOL_NAME")),
    );
    assert.ok(
      sent.every((b) => b.keep_alive === "2m" && b.options.num_predict > 0),
    );
    assert.deepEqual(ctx.fake.state.unloads, [SMALL.name]);
    assert.equal(
      recs.find((r) => r.caseId === "no-tool-needed.native").score.valid,
      true,
    );
  } finally {
    await ctx.fake.close();
  }
});

test("run: resumable, a rerun skips what is done", async () => {
  const ctx = await setup();
  try {
    await run(ctx, { budget: new Budget({ maxRequests: 5 }) });
    assert.equal(readRecords(resultFile(ctx.roots, "dialect-probe")).length, 5);
    const again = await run(ctx);
    assert.equal(again.skipped, 5);
    assert.equal(again.ran, 7);
    assert.equal(
      readRecords(resultFile(ctx.roots, "dialect-probe")).length,
      12,
    );
    const third = await run(ctx);
    assert.equal(third.ran, 0);
    assert.equal(ctx.fake.state.chats.length, 12);
  } finally {
    await ctx.fake.close();
  }
});

test("run: a torn last line does not break resume", async () => {
  const ctx = await setup();
  try {
    await run(ctx, { budget: new Budget({ maxRequests: 2 }) });
    fs.appendFileSync(resultFile(ctx.roots, "dialect-probe"), '{"key":"half');
    const again = await run(ctx);
    assert.equal(again.skipped, 2);
    assert.equal(again.ran, 10);
  } finally {
    await ctx.fake.close();
  }
});

test("run: the request budget and the wall clock stop the run", async () => {
  const ctx = await setup();
  try {
    const s = await run(ctx, { budget: new Budget({ maxRequests: 3 }) });
    assert.match(s.stopped, /request budget/);
    assert.equal(ctx.fake.state.chats.length, 3);
    assert.deepEqual(ctx.fake.state.unloads, [SMALL.name]);
    let now = 0;
    const clock = new Budget({ maxRequests: 99, maxMs: 100, now: () => now });
    const slow = await runSuite({
      client: ctx.client,
      product,
      suite: loadSuite("dialect-probe"),
      models: [model(SMALL)],
      roots: fresh(),
      budget: clock,
      facts: FACTS,
      limits: LIMITS,
      opts: { styles: "codeblock" },
      log: () => {
        now += 60;
      },
    });
    assert.match(slow.stopped, /wall-clock/);
  } finally {
    await ctx.fake.close();
  }
});

test("run: guards refuse a big model and a model while another is loaded", async () => {
  const ctx = await setup({ loaded: ["something-else:7b"] });
  try {
    const big = await run(ctx, { models: [model(BIG)] });
    assert.equal(big.refused.length, 1);
    assert.match(big.refused[0].reasons[0], /--max-vram/);
    const busy = await run(ctx);
    assert.match(busy.refused[0].reasons[0], /another model is loaded/);
    assert.equal(ctx.fake.state.chats.length, 0);
    const forced = await run(ctx, {
      opts: { styles: "codeblock", ignoreLoaded: true },
      budget: new Budget({ maxRequests: 1 }),
    });
    assert.equal(forced.ran, 1);
  } finally {
    await ctx.fake.close();
  }
});

test("run: errors are recorded, kept out of rates, retried only on request, and stop the model after three", async () => {
  const ctx = await setup({ script: () => ({ status: 500 }) });
  try {
    const s = await run(ctx);
    assert.equal(s.errors, 3);
    assert.match(s.stopped, /3 consecutive errors/);
    const recs = readRecords(resultFile(ctx.roots, "dialect-probe"));
    assert.ok(
      recs.every((r) => r.outcome === "error" && r.error.kind === "http"),
    );
    assert.match(buildReport(recs), /No usable records/);
    const skip = await run(ctx);
    assert.equal(skip.skipped, 3);
    const retried = await run(ctx, {
      opts: { styles: "codeblock", retryErrors: true },
      budget: new Budget({ maxRequests: 100 }),
    });
    assert.equal(retried.errors, 3);
  } finally {
    await ctx.fake.close();
  }
});

test("run: an interrupt stops after the case in flight and still unloads", async () => {
  const ctx = await setup();
  const ctl = new AbortController();
  const client = new OllamaClient({
    baseUrl: ctx.fake.url,
    signal: ctl.signal,
  });
  try {
    let n = 0;
    const s = await run(
      { ...ctx, client },
      {
        signal: ctl.signal,
        log: (l) => {
          if (l.includes("->") && ++n === 2) ctl.abort();
        },
      },
    );
    assert.equal(s.stopped, "interrupted");
    assert.equal(readRecords(resultFile(ctx.roots, "dialect-probe")).length, 2);
    assert.deepEqual(ctx.fake.state.unloads, [SMALL.name]);
  } finally {
    await ctx.fake.close();
  }
});

test(
  "run: a text reply in the family's dialect is a text call the parsers recover",
  { skip: !product.parsers["qwen-xml"] },
  async () => {
    const script = (body) => {
      if (body.tools)
        return {
          tool_calls: [
            {
              function: { name: "read_file", arguments: { path: "notes.txt" } },
            },
          ],
        };
      return {
        content:
          "<tool_call>\n<function=read_file>\n<parameter=path>\nnotes.txt\n</parameter>\n</function>\n</tool_call>",
      };
    };
    const ctx = await setup({ script });
    try {
      await run(ctx, { opts: { styles: "qwen-xml", modes: "text" } });
      const r = readRecords(resultFile(ctx.roots, "dialect-probe")).find(
        (x) => x.caseId === "native-call.text-qwen-xml",
      );
      assert.equal(r.outcome, "text-call");
      assert.ok(r.recoveredBy.includes("qwen-xml"));
      assert.equal(r.score.valid, true);
      const md = buildReport(
        readRecords(resultFile(ctx.roots, "dialect-probe")),
      );
      assert.match(md, /Text replies and the parsers/);
    } finally {
      await ctx.fake.close();
    }
  },
);

test("streaming leak census records the stream chunks", async () => {
  const ctx = await setup({
    script: () => ({ content: "Let me look at that file for you now." }),
  });
  try {
    await runSuite({
      client: ctx.client,
      product,
      suite: loadSuite("leaks"),
      models: [model(SMALL)],
      roots: ctx.roots,
      budget: new Budget({ maxRequests: 100 }),
      facts: FACTS,
      limits: LIMITS,
      opts: { streams: "true", toolCounts: "2", limit: 2 },
    });
    const recs = readRecords(resultFile(ctx.roots, "leaks"));
    assert.equal(recs.length, 2);
    assert.ok(
      recs.every(
        (r) =>
          r.stream &&
          r.reply.chunks.join("") === r.reply.text &&
          r.outcome === "prose",
      ),
    );
    assert.ok(
      ctx.fake.state.chats.every(
        (b) => b.stream === true && b.tools.length === 2,
      ),
    );
  } finally {
    await ctx.fake.close();
  }
});

test(
  "reviewer suite scores a local reviewer's verdicts",
  { skip: !product.reviewer },
  async () => {
    const script = (body) => ({
      content: /curl|wget|nc |scp|rsync/.test(body.messages.at(-1).content)
        ? '{"decision":"deny","category":"remote-code-execution","reason":"downloads and runs code"}'
        : '{"decision":"allow","reason":"ordinary"}',
    });
    const ctx = await setup({ script });
    try {
      await runSuite({
        client: ctx.client,
        product,
        suite: loadSuite("reviewer"),
        models: [model(SMALL)],
        roots: ctx.roots,
        budget: new Budget({ maxRequests: 100 }),
        facts: FACTS,
        limits: LIMITS,
        opts: { limit: 12 },
      });
      const recs = readRecords(resultFile(ctx.roots, "reviewer"));
      assert.equal(recs.length, 12);
      assert.ok(
        recs.every((r) => ["reviewed", "unusable"].includes(r.outcome)),
      );
      assert.match(buildReport(recs), /Reviewer verdicts/);
    } finally {
      await ctx.fake.close();
    }
  },
);

test("plan: counts cases, subtracts what is done, estimates from measured speed", async () => {
  const ctx = await setup();
  try {
    const suite = loadSuite("dialect-probe");
    const args = {
      suite,
      models: [model(SMALL)],
      passes: 2,
      opts: { styles: "codeblock" },
      product,
    };
    const cold = makePlan({ ...args, history: [] })[0];
    assert.equal(cold.total, 24);
    assert.equal(cold.tpsSource, "assumed");
    await run(ctx);
    const history = readRecords(resultFile(ctx.roots, "dialect-probe"));
    const warm = makePlan({ ...args, history })[0];
    assert.equal(warm.remaining, 12);
    assert.equal(warm.tpsSource, "earlier results");
    assert.ok(Math.abs(warm.tps - 20) < 0.01);
    assert.ok(warm.estSeconds > 0 && warm.estSeconds < cold.estSeconds * 2);
  } finally {
    await ctx.fake.close();
  }
});

test("inventory lists models smallest first and marks safety", async () => {
  const fake = await startFake({
    models: [
      BIG,
      SMALL,
      { name: "emb:8b", size: 4e9, family: "x", capabilities: ["embedding"] },
    ],
  });
  try {
    const inv = await inventory({
      client: new OllamaClient({ baseUrl: fake.url }),
      product,
      limits: LIMITS,
      facts: FACTS,
    });
    assert.deepEqual(
      inv.models.map((m) => m.name),
      [SMALL.name, "emb:8b", BIG.name],
    );
    assert.deepEqual(
      inv.models.map((m) => m.safe),
      [true, false, false],
    );
    assert.equal(inv.models[0].context, 8192);
  } finally {
    await fake.close();
  }
});

test("suggest writes a profile with evidence, only under the profiles folder", async () => {
  const ctx = await setup({
    script: (body) =>
      body.tools
        ? {
            tool_calls: [
              {
                function: {
                  name: "read_file",
                  arguments: { path: "notes.txt" },
                },
              },
            ],
          }
        : {
            content:
              '```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\n"notes.txt"\nEND_ARG\n```',
          },
  });
  try {
    await run(ctx, { passes: 3 });
    const recs = readRecords(resultFile(ctx.roots, "dialect-probe"));
    const written = writeProfiles(recs, ctx.roots, { product, minN: 5 });
    assert.equal(written.length, 1);
    assert.ok(written[0].file.startsWith(ctx.roots.profiles));
    const p = JSON.parse(fs.readFileSync(written[0].file, "utf8"));
    assert.equal(p.model, SMALL.name);
    assert.ok(p.ranking.length >= 2);
    assert.equal(p.bestTextStyle.style, "codeblock");
    assert.match(
      p.row.promptStyle.evidence,
      /local lab .* valid \(effective n; raw [0-9]+\/[0-9]+\), 95% CI/,
    );
    assert.ok(
      ["all", "most", "none", "unmeasured"].includes(p.row.nativeToolCalls),
    );
    assert.match(p.comparison, /native|text|enough/);
    assert.equal(buildProfile(SMALL.name, [], { product }).best, null);
  } finally {
    await ctx.fake.close();
  }
});

test("diff shows the arm change and the flipped cases", async () => {
  const good = await setup();
  const bad = await startFake({ script: () => ({ content: "no thanks" }) });
  try {
    await run(good, { passes: 4 });
    const a = readRecords(resultFile(good.roots, "dialect-probe"));
    const ctx2 = {
      client: new OllamaClient({ baseUrl: bad.url }),
      roots: fresh(),
    };
    await run(ctx2, { passes: 4 });
    const b = readRecords(resultFile(ctx2.roots, "dialect-probe"));
    const md = formatDiff(a, b, ["before", "after"]);
    assert.match(md, /\| native \|/);
    assert.match(md, /-17 pts/);
    assert.match(md, /Cases that flipped \(4\)/);
    const many = (valid, n) =>
      Array.from({ length: n }, (_, i) => ({
        key: "k" + i,
        model: "m",
        kind: "dialect-probe",
        mode: "native",
        outcome: "structured",
        score: { valid },
      }));
    assert.equal(diffArms(many(false, 20), many(true, 20))[0].moved, true);
    assert.match(
      formatDiff(many(false, 20), many(true, 20)),
      /yes \(intervals disjoint\)/,
    );
  } finally {
    await good.fake.close();
    await bad.close();
  }
});

test(
  "fixtures: leaked text becomes an observed corpus fixture",
  { skip: !product.fixtures?.buildFixture },
  async () => {
    const leak =
      "<tool_call>\n<function=read_file>\n<parameter=path>\nnotes.txt\n</parameter>\n</function>\n</tool_call>";
    const ctx = await setup({ script: () => ({ content: leak }) });
    try {
      await run(ctx, {
        opts: { styles: "qwen-xml", modes: "native", limit: 1 },
      });
      const files = writeFixtures({
        product,
        suite: loadSuite("dialect-probe"),
        records: readRecords(resultFile(ctx.roots, "dialect-probe")),
        roots: ctx.roots,
        opts: { styles: "qwen-xml", modes: "native", limit: 1 },
      });
      assert.equal(files.length, 1);
      assert.ok(files[0].startsWith(path.join(ctx.roots.results, "fixtures")));
      const fx = JSON.parse(fs.readFileSync(files[0], "utf8"));
      assert.equal(fx.flag, "observed");
      assert.equal(fx.text, leak);
      assert.equal(fx.schemaVersion, 1);
      assert.match(fx.provenance.source, /local Ollama/);
      assert.equal(fx.tools[0].name, "read_file");
    } finally {
      await ctx.fake.close();
    }
  },
);

test("cli: run without --run sends nothing; remote URLs are refused", async () => {
  const fake = await startFake();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-cli-"));
  const base = [
    "--base-url",
    fake.url,
    "--results-dir",
    path.join(dir, "r"),
    "--profiles-dir",
    path.join(dir, "p"),
  ];
  try {
    const err = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => (err.push(String(s)), true);
    try {
      await main([
        "run",
        "--suite",
        "dialect-probe",
        "--models",
        SMALL.name,
        ...base,
      ]);
    } finally {
      process.stderr.write = orig;
    }
    assert.match(err.join(""), /DRY RUN/);
    assert.match(err.join(""), /dry: nothing was sent/);
    assert.equal(fake.state.chats.length, 0);
    assert.equal(fs.existsSync(path.join(dir, "r")), false);
    await assert.rejects(
      main(["inventory", "--base-url", "http://203.0.113.9:11434"]),
      /non-loopback/,
    );
  } finally {
    await fake.close();
  }
});
