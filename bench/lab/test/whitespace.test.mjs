import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProduct } from "../adapter.mjs";
import { readRecords } from "../lib/results.mjs";
import { validateResult } from "../lib/resultSchema.mjs";
import { toServerIdentity } from "../lib/serverIdentity.mjs";
import { expandSuite, loadSuite } from "../lib/suites.mjs";
import { Engine } from "../lib/transports.mjs";
import {
  analyze,
  damage,
  firstDiff,
  formatWhitespaceReport,
  visible,
} from "../lib/whitespace.mjs";

const fx = (name) =>
  readRecords(
    fileURLToPath(
      new URL(`../fixtures/args-whitespace/${name}`, import.meta.url),
    ),
  );
const suite = loadSuite("args-whitespace");

test("the suite expands to native-only cases whose prompt carries the exact string", () => {
  const cases = expandSuite(suite, { opts: {} });
  assert.equal(cases.length, suite.probes.length);
  assert.ok(cases.every((c) => c.mode === "native" && c.sendTools));
  for (const p of suite.probes) {
    const want = p.expect.args.old_string;
    assert.ok(p.user.includes(JSON.stringify(want)), p.id);
  }
  // every kind of edge whitespace the task named is covered
  const all = suite.probes.map((p) => p.expect.args.old_string).join("|");
  for (const needle of [" ", "\t", "\n", "\r\n"])
    assert.ok(all.includes(needle));
  assert.ok(suite.probes.some((p) => p.expect.args.old_string.trim() === ""));
  assert.ok(
    suite.probes.some((p) => p.expect.args.old_string.split("\n").length > 2),
  );
});

test("firstDiff names the first differing UTF-8 byte, or where one side ends", () => {
  assert.equal(firstDiff("abc", "abc"), null);
  assert.deepEqual(firstDiff("  ab", "ab"), {
    index: 0,
    want: 0x20,
    got: 0x61,
  });
  assert.deepEqual(firstDiff("ab\n", "ab"), {
    index: 2,
    want: 0x0a,
    got: null,
  });
  assert.deepEqual(firstDiff("a", "a\r\n"), {
    index: 1,
    want: null,
    got: 0x0d,
  });
  // offsets are bytes: the diff after a two-byte character is at byte 2
  assert.deepEqual(firstDiff("éx", "éy"), {
    index: 2,
    want: 0x78,
    got: 0x79,
  });
});

test("damage separates stripped edges from other changes", () => {
  assert.equal(damage("  x\n", "x"), "stripped");
  assert.equal(damage("  x\n", "  x\n"), "none");
  assert.equal(damage("  x\n", " x"), "edges-changed");
  assert.equal(damage("a\r\nb", "a\nb"), "changed");
  assert.equal(damage("x", 5), "not-a-string");
  assert.equal(visible("a b\r\n"), "a␣b\\r\\n");
});

test("a recorded stripping server is flagged and a faithful one is not", () => {
  const arms = analyze(
    [
      ...fx("stripping-vllm-0.25.1.jsonl"),
      ...fx("faithful-llama-server.jsonl"),
    ],
    suite,
  );
  assert.equal(arms.length, 2);
  const [strip, ok] = arms;
  assert.equal(strip.verdict, "STRIPS WHITESPACE");
  assert.match(strip.server, /^vllm 0\.25\.1, parser qwen3_coder \(declared\)/);
  assert.equal(strip.exact, 1); // only the no-whitespace control survives
  assert.equal(strip.stripped, suite.probes.length - 1);
  assert.equal(ok.verdict, "FAITHFUL");
  assert.equal(ok.exact, ok.n);
  assert.match(ok.server, /parser Hermes 2 Pro \(reported\)/);
  const trailing = strip.rows.find((r) => r.caseId === "trailing-newline");
  assert.deepEqual(trailing.diff, { index: 21, want: 0x0a, got: null });
  const md = formatWhitespaceReport(arms);
  assert.match(md, /Verdict: \*\*STRIPS WHITESPACE\*\*/);
  assert.match(md, /Verdict: \*\*FAITHFUL\*\*/);
  assert.match(md, /#21: expected 0x0a, got end/);
});

test("a reply with no call, an error record and an unrelated record are handled", () => {
  const recs = fx("faithful-llama-server.jsonl");
  const mangled = recs.map((r, i) =>
    i === 0 ? { ...r, calls: [], reply: { toolCalls: [] } } : r,
  );
  mangled.push({ ...recs[1], caseId: "leading-tab.native", outcome: "error" });
  mangled.push({ ...recs[1], suite: "other" });
  const [arm] = analyze(mangled, suite);
  assert.equal(arm.verdict, "INCOMPLETE (some replies made no call)");
  assert.equal(arm.rows.filter((r) => !r.called).length, 1);
  assert.equal(analyze([], suite).length, 0);
  assert.match(formatWhitespaceReport([]), /No `args-whitespace` records/);
});

test("arguments that arrive as a JSON string are parsed before comparing", () => {
  const [r] = fx("faithful-llama-server.jsonl");
  const s = {
    ...r,
    calls: [
      { name: "edit_file", arguments: JSON.stringify(r.calls[0].arguments) },
    ],
  };
  const [arm] = analyze([s], suite);
  assert.equal(arm.exact, arm.n);
});

test("describe reads vLLM /version when /props is absent, and records a declared parser", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/version" ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/version" ? { version: "0.25.1" } : { error: "no" },
      ),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const e = new Engine({
      api: "openai-chat",
      baseUrl: url,
      declaredParser: "qwen3_coder",
    });
    const d = await e.describe("m");
    assert.equal(d.engine, "vllm");
    assert.equal(d.version, "0.25.1");
    assert.equal(d.parserDeclared, "qwen3_coder");
    assert.deepEqual(toServerIdentity(d), {
      name: "vllm",
      version: "0.25.1",
      parser: "qwen3_coder",
      parserSource: "declared",
    });
  } finally {
    server.close();
  }
});

test("server identities of the engines, and the schema accepts arm.server", async () => {
  assert.deepEqual(
    toServerIdentity({
      engine: "ollama",
      version: "0.40.13",
      parser: "qwen3-coder",
      templateSha: "0123456789abcdef",
    }),
    {
      name: "ollama",
      version: "0.40.13",
      parser: "qwen3-coder",
      parserSource: "reported",
      templateSha: "0123456789abcdef",
    },
  );
  assert.deepEqual(
    toServerIdentity({
      engine: "llama-server",
      build: "b12206",
      chatFormat: "Hermes 2 Pro",
    }),
    {
      name: "llama-server",
      version: "b12206",
      parser: "Hermes 2 Pro",
      parserSource: "reported",
    },
  );
  assert.equal(toServerIdentity(undefined), undefined);
  const sha = "a".repeat(64);
  const rec = (server) => ({
    schemaVersion: 1,
    runId: "r",
    labSha: "abc1234",
    productSha: "def5678",
    contractVersion: 2,
    arm: {
      model: "m",
      declaredQuant: "q",
      provider: "p",
      engine: "vllm 0.25.1",
      apiSurface: "openai-chat",
      clientPath: "lab",
      sampling: { temperature: 0 },
      server,
    },
    request: { sha256: sha },
    reply: { sha256: sha },
    usage: {},
    classification: { outcome: "structured", dialect: "native-structured" },
    scanStatus: "unscanned",
  });
  assert.deepEqual(
    validateResult(
      rec({
        name: "vllm",
        version: "0.25.1",
        parser: "qwen3_coder",
        parserSource: "declared",
      }),
    ),
    [],
  );
  assert.match(
    validateResult(rec({ version: "1" })).join("\n"),
    /server\.name: required/,
  );
  assert.match(
    validateResult(rec({ name: "x", parserSource: "guessed" })).join("\n"),
    /parserSource/,
  );
  // the product's own validator agrees on an identity the lab produced
  const product = await loadProduct();
  if (product.contract?.validateServerIdentity)
    assert.deepEqual(
      product.contract.validateServerIdentity(
        toServerIdentity({
          engine: "vllm",
          version: "0.25.1",
          parserDeclared: "hermes",
        }),
      ),
      [],
    );
});

test("the committed fixtures are well formed JSONL of the suite", () => {
  for (const f of [
    "stripping-vllm-0.25.1.jsonl",
    "faithful-llama-server.jsonl",
  ]) {
    const recs = fx(f);
    assert.equal(recs.length, suite.probes.length);
    assert.ok(recs.every((r) => r.suite === "args-whitespace"));
  }
  assert.ok(
    fs.existsSync(new URL("../suites/args-whitespace.json", import.meta.url)),
  );
});
