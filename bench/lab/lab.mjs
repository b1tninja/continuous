#!/usr/bin/env node
// The local lab CLI. Run `node bench/lab/lab.mjs help` for the commands.
// Read README.md first: this drives a real model on a real machine.
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadProduct } from "./adapter.mjs";
import { compareRuns, CompareError, formatCompare } from "./lib/compare.mjs";
import { formatDiff } from "./lib/diff.mjs";
import { writeFixtures } from "./lib/fixtures.mjs";
import { Budget, machineFacts } from "./lib/guards.mjs";
import { formatInventory, inventory } from "./lib/inventory.mjs";
import {
  loadDumps,
  replayRequestCount,
  replaySequences,
} from "./lib/replay.mjs";
import { buildCacheReport, cacheRequestCount, runCache } from "./lib/cache.mjs";
import { INHERIT } from "./lib/sampling.mjs";
import { APIS, Engine, isLlamaApi, THINK_VALUES } from "./lib/transports.mjs";
import { DEFAULT_EXE, startServer, stopFromPidFile } from "./lib/server.mjs";
import { roots as makeRoots, writeText } from "./lib/paths.mjs";
import { buildReport } from "./lib/report.mjs";
import { labelArms, readAll, readRecords, resultFile } from "./lib/results.mjs";
import { cfgTag, makePlan, runSuite, warmup } from "./lib/run.mjs";
import { modelGuard } from "./lib/guards.mjs";
import fs from "node:fs";
import { agentTools, loadSuite, SUITE_NAMES } from "./lib/suites.mjs";
import { writeProfiles } from "./lib/suggest.mjs";
import { analyze, formatWhitespaceReport } from "./lib/whitespace.mjs";

const HELP = `usage: node bench/lab/lab.mjs <command> [options]

commands
  inventory                 installed models, preset rows, machine facts, which are safe
  plan                      dry run: cases x models x passes and estimated time
  run --run                 run for real (without --run it only prints the plan)
  report                    markdown tables with Wilson 95% intervals on the effective n (distinct prompts), raw n beside it
  whitespace [--file F ...] whitespace fidelity of string arguments from args-whitespace results (offline, no model; vLLM issue 48753)
  diff <before> <after>     compare two result files
  compare <A> <B>           pair two result sets: rates, McNemar exact (per pass and per prompt), flipped cases;
                            --unit prompt|pass|auto (auto: prompt when the passes ran at temperature 0)
  envshell <cmd>            the env-shell-tasks suite (does telling the agent its shell reduce failed commands?): list, plan, run, selftest, replay, report, power; envshell help
  replay --dumps PATH       send recorded request dumps through the cache path, report cached/evaluated tokens
  suggest                   write profiles/<model>.json from the results
  fixtures --suite S        write observed corpus fixtures from raw replies
  snapshot-tools            write the real agent tool list (needs the product's install)
  server start|stop|status  start (foreground, Ctrl-C stops) or stop one llama-server for a GGUF

suites: ${SUITE_NAMES.join(", ")}  (or a path to a suite JSON file)

transports (README "Transports")
  --api ollama-chat|ollama-v1|ollama-raw|openai-chat|llamacpp-raw   (default ollama-chat)
  --base-url URL (default 127.0.0.1:11434; 127.0.0.1:8080 for openai-chat and llamacpp-raw; with --serve and
                  --port P the lab starts and talks to P itself. Where Strata holds 8080 use --port 18080 --base-url http://127.0.0.1:18080)
  --think on|off|default|low|medium|high   --num-predict N (-1 = no cap)
  --temperature T|inherit   a number is sent on every request; "inherit" sends NO sampling option
                            (no temperature, top_p, top_k, penalties), so the server and its Modelfile apply
  --seed N                  base seed: pass p sends N+p-1 (distinct, reproducible draws at temperature > 0)
  --tool-choice auto|required|none|<tool name>   --body-extra '{"json":"merged into the body"}'
  --gguf FILE (llama-server apis: size guard; with --serve, the file to start)  --serve (start and stop llama-server for the run)
  --exe FILE  --port N  --ctx N  --ngl N  --parallel N  --alias NAME  --chat-template NAME  --chat-template-file FILE
  --metrics  --slots (llama-server: start with the endpoint on, and poll /slots and /metrics after each request)
  --size-gb N --alias NAME (instead of --gguf, for a server whose weights are not a local file, such as vLLM: N is the size guard, NAME the served model name)
  --tool-parser NAME (the tool-call parser the server was started with, for vLLM's --tool-call-parser: it reports none; recorded as engine.parserDeclared)
  --server-log FILE (the log to read the Chat format: line from when the server was not started by --serve)
  --dumps PATH (replay)  --model-a M  --model-b M (compare, when a side holds several models)
  --cache-reuse N  --reasoning-format F  --server-arg ARG (repeatable)  --no-vram-check  --ready-timeout S
  --out DIR (plan/run/fixtures: results folder; report/diff/snapshot-tools: a file)  --results-dir DIR
  --log-dir DIR  --allow-root DIR (repeatable extra write roots)  --ollama-url URL (the "is anything loaded" check)

common options
  --suite S  --models a,b|smallest-safe|all-safe  --limit N
  --passes N                repeat every case N times. At temperature 0 a pass repeats the same output: n stays the
                            prompt count and passes only check determinism. Use temperature > 0 with --seed, or more
                            prompts, for a bigger n; the plan and every report print raw and effective n.
  --base-url URL (loopback only unless --allow-remote)  --product DIR
  --max-vram GB (default 8)  --max-ram GB (default 16)
  --max-requests N (60)  --max-minutes N (30)  --model-minutes N (15)
  --request-timeout S (120)  --cooldown S (15)  --retry-errors  --ignore-loaded
  --styles auto|all|a,b  --modes native,text  --variants FILE  --deliveries native,text
  --dataset FILE  --tool-counts 2,14,60,agent  --temperatures 0,0.7 (one value with --temperature inherit)  --streams false,true
  --num-ctx N (default 8192; the leaks suite uses 16384)  --full-grid  --warmup (plan: send one tiny request per model)  --out FILE  --file F (repeatable)
`;

const OPTIONS = {
  suite: { type: "string" },
  models: { type: "string" },
  passes: { type: "string", default: "1" },
  limit: { type: "string" },
  "base-url": { type: "string" },
  api: { type: "string", default: "ollama-chat" },
  "ollama-url": { type: "string", default: "http://127.0.0.1:11434" },
  think: { type: "string" },
  temperature: { type: "string" },
  "num-predict": { type: "string" },
  "tool-choice": { type: "string" },
  seed: { type: "string" },
  "body-extra": { type: "string" },
  gguf: { type: "string" },
  serve: { type: "boolean" },
  exe: { type: "string" },
  port: { type: "string" },
  ctx: { type: "string" },
  ngl: { type: "string" },
  parallel: { type: "string" },
  alias: { type: "string" },
  "chat-template": { type: "string" },
  "chat-template-file": { type: "string" },
  "cache-reuse": { type: "string" },
  "reasoning-format": { type: "string" },
  "server-arg": { type: "string", multiple: true },
  metrics: { type: "boolean" },
  slots: { type: "boolean" },
  "server-log": { type: "string" },
  "tool-parser": { type: "string" },
  "size-gb": { type: "string" },
  dumps: { type: "string" },
  "model-a": { type: "string" },
  "model-b": { type: "string" },
  "no-vram-check": { type: "boolean" },
  "ready-timeout": { type: "string", default: "300" },
  "log-dir": { type: "string" },
  "allow-root": { type: "string", multiple: true },
  "allow-remote": { type: "boolean" },
  product: { type: "string" },
  run: { type: "boolean" },
  "max-vram": { type: "string", default: "8" },
  "max-ram": { type: "string", default: "16" },
  "max-requests": { type: "string", default: "60" },
  "max-minutes": { type: "string", default: "30" },
  "model-minutes": { type: "string", default: "15" },
  "request-timeout": { type: "string", default: "120" },
  cooldown: { type: "string", default: "15" },
  "retry-errors": { type: "boolean" },
  "ignore-loaded": { type: "boolean" },
  styles: { type: "string" },
  modes: { type: "string" },
  variants: { type: "string" },
  deliveries: { type: "string" },
  dataset: { type: "string" },
  "tool-counts": { type: "string" },
  temperatures: { type: "string" },
  streams: { type: "string" },
  "full-grid": { type: "boolean" },
  warmup: { type: "boolean" },
  out: { type: "string" },
  file: { type: "string", multiple: true },
  concurrency: { type: "string" },
  "num-ctx": { type: "string" },
  "min-n": { type: "string", default: "8" },
  unit: { type: "string", default: "auto" },
  "only-leaks": { type: "boolean" },
  "results-dir": { type: "string" },
  "profiles-dir": { type: "string" },
  help: { type: "boolean", short: "h" },
};

const die = (msg, code = 2) => {
  process.stderr.write(msg + "\n");
  process.exit(code);
};
const log = (s) => process.stderr.write(s + "\n");
const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    die(`--${name} needs a non-negative number, got ${v}`);
  return n;
};

function suiteOptions(v) {
  return {
    styles: v.styles,
    modes: v.modes,
    variants: v.variants,
    deliveries: v.deliveries,
    dataset: v.dataset,
    toolCounts: v["tool-counts"],
    temperatures: v.temperatures,
    streams: v.streams,
    fullGrid: v["full-grid"],
    numCtx: v["num-ctx"] ? num(v["num-ctx"], "num-ctx") : undefined,
    limit: v.limit ? num(v.limit, "limit") : undefined,
    retryErrors: v["retry-errors"],
    ignoreLoaded: v["ignore-loaded"],
  };
}

/** A result directory, or one file as the single-file list readAll takes. */
const fileOrDir = (p) =>
  fs.existsSync(p) && fs.statSync(p).isFile() ? [p] : p;

async function pickModels(spec, inv) {
  if (!spec) die("--models is required (names, smallest-safe or all-safe)");
  const safe = inv.models.filter((m) => m.safe);
  if (spec === "smallest-safe") return safe.slice(0, 1);
  if (spec === "all-safe") return safe;
  return spec.split(",").map((n) => {
    const m = inv.models.find((x) => x.name === n.trim());
    if (!m)
      die(
        `model ${n} is not installed (see \`inventory\`); the lab never pulls models`,
      );
    return m;
  });
}

export async function main(argv, env = process.env) {
  // the env-shell-tasks suite has its own options (envshell/cli.mjs)
  if (argv[0] === "envshell")
    return (await import("./envshell/cli.mjs")).main(argv.slice(1), env);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (e) {
    return die(`${e.message}\n\n${HELP}`);
  }
  const { values: v, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  if (!cmd || cmd === "help" || v.help) return process.stdout.write(HELP);
  if (v.concurrency && v.concurrency !== "1")
    return die(
      "the lab runs one request at a time; --concurrency is fixed at 1",
    );
  // --out is a file for report/diff/snapshot-tools and a results folder for the rest
  const outIsFile = ["report", "diff", "snapshot-tools", "whitespace"].includes(
    cmd,
  );
  const roots = makeRoots({
    results: v["results-dir"] ?? (outIsFile ? undefined : v.out),
    profiles: v["profiles-dir"],
    logs: v["log-dir"],
    allow: v["allow-root"],
  });
  if (!APIS.includes(v.api))
    return die(`--api must be one of ${APIS.join(", ")}, got ${v.api}`);
  if (v.think && !THINK_VALUES.includes(v.think))
    return die(`--think must be one of ${THINK_VALUES.join(", ")}`);
  const cfg = { api: v.api };
  if (v.think) cfg.think = v.think;
  if (v.temperature != null)
    cfg.temperature =
      v.temperature === INHERIT ? INHERIT : num(v.temperature, "temperature");
  if (cfg.temperature === INHERIT && v.temperatures?.split(",").length > 1)
    return die(
      "--temperature inherit sends no temperature, so a --temperatures grid of several values would run the same request several times: give one value",
    );
  if (v["num-predict"] != null) {
    cfg.numPredict = Number(v["num-predict"]);
    if (!Number.isInteger(cfg.numPredict))
      return die("--num-predict needs an integer (-1 = no cap)");
  }
  if (v["tool-choice"]) cfg.toolChoice = v["tool-choice"];
  if (v.seed != null) {
    cfg.seed = Number(v.seed);
    if (!Number.isInteger(cfg.seed)) return die("--seed needs an integer");
  }
  if (v["body-extra"]) {
    try {
      cfg.bodyExtra = JSON.parse(v["body-extra"]);
    } catch {
      return die("--body-extra needs a JSON object");
    }
    if (
      !cfg.bodyExtra ||
      typeof cfg.bodyExtra !== "object" ||
      Array.isArray(cfg.bodyExtra)
    )
      return die("--body-extra needs a JSON object");
  }
  const llama = isLlamaApi(v.api);
  const limits = {
    maxVramGB: num(v["max-vram"], "max-vram"),
    maxRamGB: num(v["max-ram"], "max-ram"),
  };
  const ctl = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    log(
      "\ninterrupted: finishing this request, unloading the model, then exiting (Ctrl-C again to quit now)",
    );
    ctl.abort();
  });

  if (cmd === "report") {
    const recs = v.file?.length ? readAll(v.file) : readAll(roots.results);
    const recs2 = v.suite ? recs.filter((r) => r.suite === v.suite) : recs;
    const md =
      buildReport(labelArms(recs2.filter((r) => r.kind !== "cache"))) +
      buildCacheReport(recs2);
    return v.out
      ? log("wrote " + writeText(v.out, md, roots))
      : process.stdout.write(md);
  }
  if (cmd === "whitespace") {
    const recs = v.file?.length ? readAll(v.file) : readAll(roots.results);
    const suite = loadSuite(v.suite ?? "args-whitespace");
    const md = formatWhitespaceReport(analyze(labelArms(recs), suite));
    return v.out
      ? log("wrote " + writeText(v.out, md, roots))
      : process.stdout.write(md);
  }
  if (cmd === "diff") {
    if (rest.length !== 2)
      return die("diff needs two result files: diff <before> <after>");
    const md = formatDiff(readRecords(rest[0]), readRecords(rest[1]), [
      path.basename(rest[0]),
      path.basename(rest[1]),
    ]);
    return v.out
      ? log("wrote " + writeText(v.out, md, roots))
      : process.stdout.write(md);
  }

  if (cmd === "compare") {
    if (rest.length !== 2)
      return die(
        "compare needs two result sets: compare <resultsA> <resultsB>",
      );
    let res;
    try {
      res = compareRuns(
        readAll(fileOrDir(rest[0])),
        readAll(fileOrDir(rest[1])),
        {
          modelA: v["model-a"],
          modelB: v["model-b"],
          unit: v.unit,
        },
      );
    } catch (e) {
      if (e instanceof CompareError) return die(e.message);
      throw e;
    }
    const md = formatCompare(
      res,
      rest.map((x) => path.basename(x)),
    );
    return v.out
      ? log("wrote " + writeText(v.out, md, roots))
      : process.stdout.write(md);
  }

  const serverOpts = () => ({
    exe: v.exe ?? DEFAULT_EXE,
    gguf: v.gguf ?? die("--gguf FILE is required"),
    port: v.port ? num(v.port, "port") : 8080,
    ctx: v.ctx ? num(v.ctx, "ctx") : 16384,
    ngl: v.ngl ? num(v.ngl, "ngl") : 99,
    parallel: v.parallel ? num(v.parallel, "parallel") : 1,
    alias: v.alias,
    chatTemplate: v["chat-template"],
    chatTemplateFile: v["chat-template-file"],
    cacheReuse:
      v["cache-reuse"] != null
        ? num(v["cache-reuse"], "cache-reuse")
        : undefined,
    reasoningFormat: v["reasoning-format"],
    metrics: v.metrics,
    slots: v.slots,
    extra: v["server-arg"] ?? [],
    ollamaUrl: v["ollama-url"],
    checkVram: !v["no-vram-check"],
    readyTimeoutMs: num(v["ready-timeout"], "ready-timeout") * 1000,
  });
  if (cmd === "server") {
    const sub = rest[0];
    if (sub === "stop") {
      const r = stopFromPidFile(roots);
      return log(
        r.stopped
          ? `killed llama-server pid ${r.pid}`
          : `nothing stopped (${r.reason ?? "process already gone"})`,
      );
    }
    if (sub === "status") {
      const pidFile = path.join(roots.logs, "llama-server.pid");
      return log(
        fs.existsSync(pidFile)
          ? `pid file ${pidFile}: ${fs.readFileSync(pidFile, "utf8").trim()}`
          : "no lab-started llama-server",
      );
    }
    if (sub !== "start") return die("server needs start, stop or status");
    const h = await startServer(serverOpts(), roots, { signal: ctl.signal });
    log(
      `llama-server ready at ${h.baseUrl} (pid ${h.pid}), log ${h.logFile}\nChat format: ${h.chatFormat() ?? "not in the log"}\nCtrl-C stops it.`,
    );
    try {
      await new Promise((r) =>
        ctl.signal.addEventListener("abort", r, { once: true }),
      );
    } finally {
      h.stop();
      log("llama-server stopped");
    }
    return;
  }

  const product = await loadProduct(v.product);
  if (product.root && product.contractProblems.length) {
    log("refusing to run: this product build disagrees with the lab contract");
    for (const m of product.contractProblems) log(`  ${m}`);
    process.exit(2);
  }
  for (const m of product.missing)
    log(`note: product feature unavailable: ${m}`);

  if (cmd === "suggest") {
    const recs = v.file?.length ? readAll(v.file) : readAll(roots.results);
    const written = writeProfiles(recs, roots, {
      product,
      minN: num(v["min-n"], "min-n"),
    });
    for (const w of written)
      log(
        `profile ${w.model}: ${w.file}\n  best: ${w.profile.best ? `${w.profile.best.arm} ${w.profile.best.k}/${w.profile.best.n} effective, raw ${w.profile.best.rawK}/${w.profile.best.rawN}` : "not enough evidence"}; ${w.profile.comparison}`,
      );
    return written.length || log("no results to learn from");
  }
  if (cmd === "snapshot-tools") {
    const tools = await product.agentTools();
    return log(
      "wrote " +
        writeText(
          v.out ?? path.join(roots.results, "agent-tools.snapshot.json"),
          JSON.stringify(tools, null, 2) + "\n",
          roots,
        ) +
        `  (${tools.length} tools; copy to bench/lab/fixtures/agent-tools.json to adopt)`,
    );
  }

  const client = new Engine({
    api: v.api,
    baseUrl:
      v["base-url"] ??
      (llama ? "http://127.0.0.1:8080" : "http://127.0.0.1:11434"),
    ollamaUrl: v["ollama-url"],
    allowRemote: v["allow-remote"],
    requestTimeoutMs: num(v["request-timeout"], "request-timeout") * 1000,
    signal: ctl.signal,
    sidecar: { slots: v.slots, metrics: v.metrics },
    serverLog: v["server-log"],
    declaredParser: v["tool-parser"],
  });
  const facts = machineFacts({ env });
  let server;
  let inv;
  if (llama) {
    // llama-server lists no sizes: the GGUF file is the size fact. A running
    // server already holds its VRAM, so the free-VRAM check belongs to the
    // server helper (before it starts), not to the model guard.
    if (!v.gguf && !(v["size-gb"] && v.alias))
      return die(
        `--api ${v.api} needs --gguf FILE (its size is the guard; --serve starts it), or --size-gb N with --alias NAME for a server whose weights are not a local file (vLLM)`,
      );
    if (v.serve && cmd === "run" && v.run) {
      server = await startServer(serverOpts(), roots, { signal: ctl.signal });
      log(
        `llama-server ready at ${server.baseUrl}; Chat format: ${server.chatFormat() ?? "not in the log"}`,
      );
      client.origin = server.baseUrl;
      client.serverLog = server.logFile;
    }
    const size = v.gguf
      ? fs.statSync(v.gguf).size
      : num(v["size-gb"], "size-gb") * 1e9;
    const name = v.alias ?? path.basename(v.gguf).replace(/\.gguf$/i, "");
    const row = {
      name,
      size,
      sizeGB: size / 1e9,
      family: "gguf",
      capabilities: ["completion", "tools"],
      toolsCapable: true,
    };
    row.guard = modelGuard(
      { name, sizeBytes: size, capabilities: row.capabilities, family: "gguf" },
      limits,
      undefined,
    );
    row.safe = row.guard.ok;
    inv = { facts, loaded: [], models: [row] };
    if (!v.models) v.models = name;
    if (cmd === "inventory")
      return process.stdout.write(
        `llama-server model ${name}: ${(size / 1e9).toFixed(1)} GB, ${row.safe ? "within the limits" : "REFUSED: " + row.guard.reasons.join("; ")}\n`,
      );
  } else {
    inv = await inventory({ client, product, limits, facts });
    if (cmd === "inventory")
      return process.stdout.write(formatInventory(inv, limits));
  }
  try {
    return await runCommand();
  } finally {
    server?.stop();
  }

  async function runCommand() {
    if (cmd === "fixtures") {
      const suite = loadSuite(v.suite ?? die("--suite is required"));
      const files = writeFixtures({
        product,
        suite,
        records: readRecords(resultFile(roots, suite.suite)),
        roots,
        opts: { ...suiteOptions(v), onlyLeaks: v["only-leaks"] },
        agentTools: agentTools(),
      });
      return log(
        `wrote ${files.length} fixture(s) under ${path.join(roots.results, "fixtures")}`,
      );
    }

    if (cmd === "replay") {
      const dumpsDir =
        v.dumps ??
        [
          path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "..",
            "tier0",
            "fixtures",
            "dumps",
          ),
        ].find((d) => fs.existsSync(d)) ??
        die("--dumps PATH is required");
      const sets = loadDumps(dumpsDir);
      const models = await pickModels(v.models, inv);
      const n = replayRequestCount(sets);
      log(
        `${v.run ? "RUN" : "DRY RUN"}: replay of ${sets.length} set(s), ${n} requests per model via ${cfg.api}${cfgTag(cfg)} from ${dumpsDir}, results ${resultFile(roots, "replay")}`,
      );
      if (!v.run)
        return log("dry: nothing was sent. Add --run to run for real.");
      const s = await runCache({
        client,
        suite: { defaults: { temperature: 0, numPredict: 16 } },
        suiteName: "replay",
        buildSequences: ({ nonce }) =>
          replaySequences(sets, { nonce, api: cfg.api }),
        models,
        roots,
        budget: new Budget({
          maxRequests: num(v["max-requests"], "max-requests"),
          maxMs: num(v["max-minutes"], "max-minutes") * 60_000,
        }),
        signal: ctl.signal,
        log,
        facts: llama ? { ...facts, gpus: undefined } : facts,
        limits,
        cfg,
        numCtx: suiteOptions(v).numCtx,
        cooldownMs: num(v.cooldown, "cooldown") * 1000,
      });
      log(
        `done: ${s.ran} ran, ${s.errors} errors, ${s.refused.length} model(s) refused${s.stopped ? `; stopped: ${s.stopped}` : ""}`,
      );
      if (s.thinkRefused) process.exitCode = 1;
      if (s.stopped === "interrupted") process.exitCode = 130;
      return;
    }

    if (cmd !== "plan" && cmd !== "run")
      return die(`unknown command ${cmd}\n\n${HELP}`);
    const suite = loadSuite(v.suite ?? die("--suite is required"));
    const models = await pickModels(v.models, inv);
    const opts = suiteOptions(v);
    if (suite.kind === "cache") {
      const n = cacheRequestCount(suite);
      log(
        `${cmd === "run" && v.run ? "RUN" : "DRY RUN"}: cache suite, ${n} requests per model via ${cfg.api}${cfgTag(cfg)}, results ${resultFile(roots, "cache")}`,
      );
      if (cmd === "plan" || !v.run)
        return log("dry: nothing was sent. Add --run to run for real.");
      const budget = new Budget({
        maxRequests: num(v["max-requests"], "max-requests"),
        maxMs: num(v["max-minutes"], "max-minutes") * 60_000,
      });
      const s = await runCache({
        client,
        suite,
        models,
        roots,
        budget,
        signal: ctl.signal,
        log,
        facts: llama ? { ...facts, gpus: undefined } : facts,
        limits,
        cfg,
        stream: (v.streams ?? "false").split(",")[0] === "true",
        agentTools: agentTools(),
        numCtx: opts.numCtx,
        cooldownMs: num(v.cooldown, "cooldown") * 1000,
      });
      log(
        `done: ${s.ran} ran, ${s.errors} errors, ${s.refused.length} model(s) refused${s.stopped ? `; stopped: ${s.stopped}` : ""}`,
      );
      if (s.thinkRefused) process.exitCode = 1;
      if (s.stopped === "interrupted") process.exitCode = 130;
      return;
    }
    const passes = num(v.passes, "passes") || 1;
    const budget = new Budget({
      maxRequests: num(v["max-requests"], "max-requests"),
      maxMs: num(v["max-minutes"], "max-minutes") * 60_000,
    });
    const history = readRecords(resultFile(roots, suite.suite));
    const warm = {};
    if (cmd === "plan" && v.warmup) {
      for (const m of models) {
        const g = inv.models.find((x) => x.name === m.name);
        if (!g?.safe) {
          log(`warmup skipped for ${m.name}: not safe under the limits`);
          continue;
        }
        log(`warmup ${m.name} (1 request)`);
        try {
          budget.spend(1);
          warm[m.name] = await warmup(client, m.name);
        } catch (e) {
          log(`warmup failed: ${e.message}`);
        }
        await client.unload(m.name);
      }
    }
    const plan = makePlan({
      suite,
      models,
      passes,
      opts,
      product,
      history,
      warm,
      agentTools: agentTools(),
      cfg,
    });
    log(
      `${cmd === "run" && v.run ? "RUN" : "DRY RUN"}: suite ${suite.suite}, results ${resultFile(roots, suite.suite)}`,
    );
    let total = 0;
    for (const p of plan) {
      const g = inv.models.find((x) => x.name === p.model);
      total += p.estSeconds;
      log(
        `  ${p.model}: ${p.cases} cases x ${p.passes} = ${p.total} raw n, effective n ${p.effN ?? "estimated after the run"}; ${p.nNote}
    ${p.remaining} to run, ~${(p.estSeconds / 60).toFixed(1)} min at ${p.tps ? p.tps.toFixed(1) : "20 (assumed)"} tok/s (${p.tpsSource}); ${g?.safe ? "safe" : "REFUSED: " + (g?.guard.reasons.join("; ") ?? "?")}`,
      );
    }
    log(
      `  total ~${(total / 60).toFixed(1)} min, ${plan.reduce((s, p) => s + p.remaining, 0)} requests; budget ${budget.maxRequests} requests, ${(budget.maxMs / 60000).toFixed(0)} min`,
    );
    if (cmd === "plan") return;
    if (!v.run) return log("dry: nothing was sent. Add --run to run for real.");
    const summary = await runSuite({
      client,
      product,
      suite,
      models,
      passes,
      opts,
      roots,
      budget,
      signal: ctl.signal,
      log,
      facts: llama ? { ...facts, gpus: undefined } : facts,
      limits,
      cfg,
      cooldownMs: num(v.cooldown, "cooldown") * 1000,
      modelMaxMs: num(v["model-minutes"], "model-minutes") * 60_000,
      agentTools: agentTools(),
    });
    log(
      `done: ${summary.ran} ran, ${summary.skipped} already done, ${summary.errors} errors, ${summary.refused.length} model(s) refused${summary.stopped ? `; stopped: ${summary.stopped}` : ""}`,
    );
    if (summary.thinkRefused) process.exitCode = 1;
    if (summary.stopped === "interrupted") process.exitCode = 130;
  }
}

const invoked =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  });
}
