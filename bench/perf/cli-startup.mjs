#!/usr/bin/env node
// Times how long the built CLI takes to start, in several scenarios.
//
//   node bench/perf/cli-startup.mjs --out <dir outside the repo> [--cn extensions/cli/dist/cn.js]
//        [--runs 12] [--only <text>] [--big-repo <dir>]
//
// No model is called and no key is read. The `-p` scenarios talk to a stub
// server this script starts on 127.0.0.1 (one canned reply), or to a closed
// local port. The CLI's global folder is a new folder under --out, so the
// real ~/.continuous is not read or written.
//
// Reports per scenario: wall time (median, p95, min, max, stddev), the time
// from spawn to the first request reaching the stub, the child's peak RSS and
// its CPU time. Two warm-up runs are dropped. Writes cli-startup.json to --out.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { round, summarize } from "./src/stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = flag("--out");
if (!out) {
  console.error("Usage: cli-startup.mjs --out <dir outside the repository>");
  process.exit(2);
}
if (resolve(out) === repo || resolve(out).startsWith(repo + sep)) {
  console.error("--out must be outside the repository");
  process.exit(2);
}
const cn = resolve(flag("--cn") ?? join(repo, "extensions/cli/dist/cn.js"));
const RUNS = Number(flag("--runs") ?? 12);
const WARMUP = 2;
const only = flag("--only");
const bigRepo = flag("--big-repo");
const hook = pathToFileURL(join(here, "src", "exit-hook.mjs")).href;

mkdirSync(out, { recursive: true });
const globalDir = join(out, "global-dir");
const emptyDir = join(out, "empty-dir");
mkdirSync(globalDir, { recursive: true });
mkdirSync(emptyDir, { recursive: true });

// The stub: one canned streamed reply for every request.
let lastRequestAt = 0;
const sse = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = http.createServer((req, res) => {
  lastRequestAt = performance.now();
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ role: "assistant", content: "ok" }));
    res.write(sse({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const config = (apiBase) =>
  `name: perf\nversion: 0.0.1\nschema: v1\nmodels:\n  - name: stub\n    provider: openai\n    model: stub\n    apiBase: ${apiBase}\n    apiKey: none\n    roles: [chat]\n`;
const stubConfig = join(out, "stub.yaml");
writeFileSync(
  stubConfig,
  config(`http://127.0.0.1:${server.address().port}/v1`),
);
// port 9 (discard) is closed on a normal machine: the connection is refused
const deadConfig = join(out, "dead.yaml");
writeFileSync(deadConfig, config("http://127.0.0.1:9/v1"));

function runOnce(cliArgs, { cwd, env = {} }) {
  return new Promise((done) => {
    const exitFile = join(out, "exit.jsonl");
    if (existsSync(exitFile)) rmSync(exitFile);
    lastRequestAt = 0;
    const t0 = performance.now();
    const child = spawn(process.execPath, ["--import", hook, cn, ...cliArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CONTINUOUS_GLOBAL_DIR: globalDir,
        CONTINUE_GLOBAL_DIR: globalDir,
        PERF_EXIT_FILE: exitFile,
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const wall = performance.now() - t0;
      let exit = null;
      try {
        exit = JSON.parse(
          readFileSync(exitFile, "utf8").trim().split("\n").pop(),
        );
      } catch {
        // the child was killed, or the hook could not write
      }
      done({
        wall,
        code,
        toRequest: lastRequestAt ? lastRequestAt - t0 : null,
        exit,
        output: output.slice(0, 300),
      });
    });
  });
}

function bareNode() {
  return new Promise((done) => {
    const t0 = performance.now();
    spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }).on("close", () =>
      done({ wall: performance.now() - t0, code: 0 }),
    );
  });
}

const compileCache = { NODE_COMPILE_CACHE: join(out, "compile-cache") };
const prompt = ["-p", "--config", stubConfig, "hi"];
const scenarios = [
  { name: "node -e 0 (baseline)", bare: true },
  { name: "--version", args: ["--version"], cwd: emptyDir },
  { name: "--help", args: ["--help"], cwd: emptyDir },
  {
    name: "--version, compile cache",
    args: ["--version"],
    cwd: emptyDir,
    env: compileCache,
  },
  { name: "-p stub, empty dir (no git)", args: prompt, cwd: emptyDir },
  { name: "-p stub, this repository", args: prompt, cwd: repo },
  ...(bigRepo
    ? [{ name: "-p stub, big repository", args: prompt, cwd: bigRepo }]
    : []),
  {
    name: "-p stub, empty dir, compile cache",
    args: prompt,
    cwd: emptyDir,
    env: compileCache,
  },
  {
    name: "-p refused port, empty dir",
    args: ["-p", "--config", deadConfig, "hi"],
    cwd: emptyDir,
  },
];

const results = [];
for (const s of scenarios) {
  if (only && !s.name.includes(only)) continue;
  const walls = [];
  const toRequest = [];
  const rss = [];
  const cpu = [];
  let last = null;
  for (let i = 0; i < RUNS + WARMUP; i++) {
    const r = s.bare ? await bareNode() : await runOnce(s.args, s);
    if (i < WARMUP) continue;
    last = r;
    walls.push(r.wall);
    if (r.toRequest) toRequest.push(r.toRequest);
    if (r.exit) {
      rss.push(r.exit.maxRSSkB / 1024);
      cpu.push(r.exit.userCpuMs + r.exit.sysCpuMs);
    }
  }
  const row = {
    name: s.name,
    runs: RUNS,
    exitCode: last.code,
    wallMs: summarize(walls),
    toRequestMs: toRequest.length ? summarize(toRequest) : null,
    peakRssMB: rss.length ? summarize(rss) : null,
    cpuMs: cpu.length ? summarize(cpu) : null,
    sampleOutput: last.output,
  };
  results.push(row);
  const w = row.wallMs;
  console.log(
    `${s.name}: wall median ${round(w.median)} p95 ${round(w.p95)} min ${round(w.min)} max ${round(w.max)} sd ${round(w.stddev)}` +
      (row.toRequestMs
        ? ` | to request median ${round(row.toRequestMs.median)} p95 ${round(row.toRequestMs.p95)}`
        : "") +
      (row.peakRssMB
        ? ` | peak RSS ${round(row.peakRssMB.median)} MB | cpu ${round(row.cpuMs.median)} ms`
        : "") +
      ` | exit ${last.code}`,
  );
}
server.close();
writeFileSync(
  join(out, "cli-startup.json"),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      date: new Date().toISOString(),
      cn,
      results,
    },
    null,
    2,
  ),
);
