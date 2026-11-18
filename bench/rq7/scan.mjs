#!/usr/bin/env node
// RQ7: false-call rate of every text tool-call recovery parser over every
// assistant reply that is not a tool call, found inside this repository.
// Dev only. Reads files under the repository root and writes nothing; prints
// counts and masked 120-character excerpts (core/util/secretScan masking).
//
//   node bench/rq7/scan.mjs [--json]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { dirname, join, relative, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.execArgv.includes("--experimental-transform-types")) {
  // The parsers use TypeScript parameter properties, which need this flag.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(HERE, "..", "..");
register(pathToFileURL(join(HERE, "loader.mjs")).href);

const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const { createTextToolRecovery } = await imp(
  "packages/openai-adapters/src/dialects/recovery.ts",
);
const { WRAPPER_ROWS } = await imp(
  "packages/openai-adapters/src/dialects/wrapperDialects.ts",
);
const { isLeakedToolCall, detectToolDialectLeak } = await imp(
  "core/util/toolDialectLeak.ts",
);
const { classifyToolReply } = await imp("core/util/toolDialectDetect.ts");
const { NEGATIVE } = await imp("core/util/toolDialectDetect.fixtures.ts");
const { scrubForDisk } = await imp("core/util/secretScan/scrubForDisk.ts");

const JSON_OUT = process.argv.includes("--json");
const STREAM_CHUNK = 13;

const DIALECTS = [
  "qwen-xml",
  "pythonic",
  "llama-json",
  "hermes-json",
  "glm-xml",
  "kimi-tokens",
  "kimi-xtml",
  "minimax-xml",
  "minimax-ns-xml",
  "toolcall-json",
  "harmony",
  "mistral",
  "dsml",
  "deepseek-v31",
  "deepseek-r1",
  ...WRAPPER_ROWS.map((r) => r.dialect),
];

const mask = (s) =>
  scrubForDisk(String(s)).replace(/\s+/g, " ").trim().slice(0, 120);

// ---------------------------------------------------------------- inputs
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "build"]);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p);
    else if (
      /\.jsonl?$/.test(name) &&
      !/package-lock|tsconfig/.test(name) &&
      st.size < 30e6
    )
      yield p;
  }
}

const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
      : "";
const hasCalls = (o) =>
  (Array.isArray(o.tool_calls) && o.tool_calls.length > 0) ||
  (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) ||
  (Array.isArray(o.content) &&
    o.content.some((p) => p?.type === "tool_use" || p?.toolUse));

const replies = new Map(); // sha -> {text, sources}
const stats = { files: 0, assistantWithCalls: 0 };
function add(text, source) {
  if (typeof text !== "string" || text.trim() === "") return;
  const h = createHash("sha256").update(text).digest("hex");
  const e = replies.get(h) ?? { text, sources: new Set() };
  e.sources.add(source);
  replies.set(h, e);
}
function visit(v, src, depth = 0) {
  if (depth > 40 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) return v.forEach((x) => visit(x, src, depth + 1));
  if (v.role === "assistant" && "content" in v) {
    if (hasCalls(v)) stats.assistantWithCalls++;
    else add(textOf(v.content), src + ":history");
  }
  if (typeof v.rawReply === "string") add(v.rawReply, src + ":rawReply");
  if (
    v.response &&
    typeof v.response.text === "string" &&
    !(v.response.calls?.length > 0)
  )
    add(v.response.text, src + ":response.text");
  for (const x of Object.values(v)) visit(x, src, depth + 1);
}

// Tools offered, for the parsers that only accept a declared name.
const tools = JSON.parse(
  readFileSync(join(ROOT, "bench/lab/fixtures/agent-tools.json"), "utf8"),
);
const toolNames = tools.map((t) => t.name);

const corpusNeg = [];
const corpusPos = [];
const corpusDir = join(ROOT, "core/llm/toolDialects/corpus/fixtures");
for (const p of walk(ROOT)) {
  const rel = relative(ROOT, p).replace(/\\/g, "/");
  stats.files++;
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    continue;
  }
  const src = rel.split("/").slice(0, 3).join("/");
  try {
    if (p.startsWith(corpusDir)) {
      const f = JSON.parse(raw);
      (f.expected?.calls?.length ? corpusPos : corpusNeg).push(f);
    } else if (p.endsWith(".jsonl")) {
      for (const line of raw.split("\n")) {
        if (line.trim()) visit(JSON.parse(line), src);
      }
    } else visit(JSON.parse(raw), src);
  } catch {
    /* not JSON we can read */
  }
}
for (const n of NEGATIVE)
  add(n.text, "core/util/toolDialectDetect.fixtures.ts:NEGATIVE");

// ------------------------------------------------------------------ scan
const asked = (d) => ({ x_continue_recover_text_tool_calls: `force:${d}` });
function run(text, d, toolList, mode) {
  try {
    const stage = createTextToolRecovery("m", toolList, asked(d));
    if (!stage) return -1;
    const size = mode === "whole" ? text.length || 1 : STREAM_CHUNK;
    let n = 0;
    const count = (evs) => (n += evs.filter((e) => e.type === "call").length);
    for (let i = 0; i < text.length; i += size)
      count(stage.push(text.slice(i, i + size)));
    count(stage.end());
    return n;
  } catch {
    return -1;
  }
}

const per = Object.fromEntries(
  DIALECTS.map((d) => [
    d,
    { scanned: 0, whole: 0, stream: 0, errors: 0, nudge: 0, examples: [] },
  ]),
);
const classes = {};
let nudgeTotal = 0;
let detectTotal = 0;
const nudgeEx = [];
for (const { text, sources } of replies.values()) {
  const cls = classifyToolReply({ content: text, knownTools: toolNames });
  const leak = isLeakedToolCall({ content: text, knownTools: toolNames });
  const detect = detectToolDialectLeak({
    content: text,
    knownTools: toolNames,
  });
  const ce = (classes[cls.dialect] ??= { n: 0, nudge: 0, ex: [] });
  ce.n++;
  if (leak) ce.nudge++;
  if (cls.dialect !== "prose" && cls.dialect !== "unknown" && ce.ex.length < 3)
    ce.ex.push(`conf=${cls.confidence} ${mask(text)}`);
  if (leak) {
    nudgeTotal++;
    if (nudgeEx.length < 9)
      nudgeEx.push({ cls: cls.dialect, ex: mask(text), src: [...sources][0] });
  }
  if (detect) detectTotal++;
  for (const d of DIALECTS) {
    const p = per[d];
    const w = run(text, d, tools, "whole");
    const s = run(text, d, tools, "stream");
    p.scanned++;
    if (w < 0 || s < 0) p.errors++;
    if (w > 0) p.whole++;
    if (s > 0) p.stream++;
    if (leak && cls.dialect === d) p.nudge++;
    if ((w > 0 || s > 0) && p.examples.length < 3)
      p.examples.push({
        src: [...sources][0],
        ex: mask(text),
        whole: w,
        stream: s,
      });
  }
}

// Corpus negatives (adversarial by design, each with its own tools) and
// positive controls (the harness must see the calls the corpus expects).
const corpusNegHits = [];
const corpusNegNudge = [];
for (const f of corpusNeg) {
  for (const d of DIALECTS) {
    const w = run(f.text, d, f.tools, "whole");
    const s = run(f.text, d, f.tools, "stream");
    if (w > 0 || s > 0)
      corpusNegHits.push({
        id: f.id,
        forDialect: f.dialect,
        parser: d,
        w,
        s,
        ex: mask(f.text),
      });
  }
  if (
    isLeakedToolCall({
      content: f.text,
      knownTools: f.tools.map((t) => t.name),
    })
  )
    corpusNegNudge.push(f.id);
}
const control = { total: 0, recovered: 0, missed: [] };
for (const f of corpusPos) {
  if (!DIALECTS.includes(f.dialect)) continue;
  control.total++;
  if (run(f.text, f.dialect, f.tools, "whole") > 0) control.recovered++;
  else control.missed.push(f.id);
}

const bySource = {};
for (const e of replies.values())
  for (const s of e.sources) bySource[s] = (bySource[s] ?? 0) + 1;

const result = {
  files: stats.files,
  uniqueReplies: replies.size,
  assistantWithCallsExcluded: stats.assistantWithCalls,
  bySource,
  corpusNegatives: corpusNeg.length,
  corpusNegativeNudge: corpusNegNudge,
  corpusNegativeParserHits: corpusNegHits,
  positiveControl: control,
  nudgeTotal,
  detectTotal,
  nudgeEx,
  classes,
  per,
};
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
  console.log(
    `json files read: ${stats.files}; unique non-call replies: ${replies.size}; assistant messages with calls excluded: ${stats.assistantWithCalls}`,
  );
  console.log("by source:", bySource);
  console.log(
    `corpus negatives: ${corpusNeg.length}; positive control ${control.recovered}/${control.total} recovered by own parser; missed: ${control.missed.join(", ") || "none"}`,
  );
  console.log("dialect              scanned  whole  stream  errors  nudge");
  for (const d of DIALECTS) {
    const p = per[d];
    console.log(
      `${d.padEnd(20)} ${String(p.scanned).padStart(7)} ${String(p.whole).padStart(6)} ${String(p.stream).padStart(7)} ${String(p.errors).padStart(7)} ${String(p.nudge).padStart(6)}`,
    );
    for (const e of p.examples)
      console.log(
        `    ACCEPTED [${e.src}] w=${e.whole} s=${e.stream}: ${e.ex}`,
      );
  }
  console.log("classifier classes:");
  for (const [k, v] of Object.entries(classes)) {
    console.log(`  ${k}: n=${v.n} nudge=${v.nudge}`);
    for (const e of v.ex) console.log(`     ${e}`);
  }
  console.log(
    `nudge hits (replies): ${nudgeTotal}; detectToolDialectLeak hits: ${detectTotal}`,
  );
  for (const e of nudgeEx) console.log(`   nudge ${e.cls} [${e.src}]: ${e.ex}`);
  console.log(
    `corpus negatives accepted by any parser: ${corpusNegHits.length}`,
  );
  for (const h of corpusNegHits.slice(0, 25))
    console.log(
      `   ${h.id} (${h.forDialect}) by ${h.parser} w=${h.w} s=${h.s}: ${h.ex}`,
    );
  console.log(
    `corpus negatives the nudge flags: ${corpusNegNudge.length} ${corpusNegNudge.slice(0, 10).join(", ")}`,
  );
}
