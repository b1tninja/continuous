// `node bench/lab/lab.mjs envshell <command>`: the env-shell-tasks suite.
//   list                       tasks, arms, failure classes
//   plan                       a dry plan: runs, requests, token and cost estimates (sends nothing)
//   run --run                  play tasks against an OpenAI-compatible endpoint (without --run: the same as plan)
//   selftest                   run the reference solutions on this host: proves tasks and checkers, no model
//   replay --input PATH...     classify recorded commands with the dialect detector, no model, no shell
//   report DIR                 the scorecard and paired comparisons of a results folder
//   oracle --input PATH...     detector against the real parser (PowerShell 5.1 ParseInput, bash -n); parses, never runs
//   power                      paired-test power: how many (task, rep) pairs to see a difference
// Dev-only. Results go outside the repository (the guard refuses a folder inside it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { LAB_ROOT } from "../lib/paths.mjs";
import { chatOpenAI, execOnHost, runTask } from "./agent.mjs";
import { ARM_IDS, buildArm, GUIDANCE } from "./arms.mjs";
import { CLASSES, classifyOutcome } from "./classify.mjs";
import {
  bashParseErrors,
  confusion,
  powershellParseErrors,
} from "./oracle.mjs";
import { formatSummary, readCommands, summarize } from "./replay.mjs";
import { formatReport, pairedPower } from "./report.mjs";
import { NAIVE, SOLUTIONS } from "./solutions.mjs";
import { prepare, TASKS } from "./tasks.mjs";

const REPO_ROOT = path.resolve(LAB_ROOT, "..", "..");

const OPTIONS = {
  run: { type: "boolean" },
  out: { type: "string" },
  models: { type: "string" },
  "base-url": { type: "string", default: "http://127.0.0.1:8080" },
  arms: { type: "string", default: "A0,A1,A2,A3" },
  tasks: { type: "string" },
  reps: { type: "string", default: "1" },
  shell: { type: "string" },
  temperature: { type: "string", default: "0.6" },
  seed: { type: "string", default: "1" },
  "max-turns": { type: "string", default: "8" },
  "max-requests": { type: "string", default: "20" },
  "max-tokens": { type: "string", default: "2048" },
  "bash-path": { type: "string" },
  "price-in": { type: "string" },
  "price-out": { type: "string" },
  baseline: { type: "string", default: "A0" },
  input: { type: "string", multiple: true },
  "all-shells": { type: "boolean" },
  "extra-body": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean" },
};

export const HELP = `envshell: does telling the agent about its shell reduce failed commands?

  list                         tasks, arms, failure classes
  plan                         dry plan (default for run): runs, requests, token and cost estimate
  run --run                    play the tasks; needs --out DIR outside the repository and --models
  selftest                     run reference solutions on this host (no model)
  replay --input PATH ...      classify recorded commands (JSON, JSONL, TS), no model
  report DIR                   scorecard and paired comparison of a results folder
  oracle --input PATH ...      detector against the shell's own parser (parse only)
  power                        paired-test power table

  --models a,b  --base-url URL (default http://127.0.0.1:8080)  --arms A0,A1,A2,A3 (A0..A7)
  --tasks ES01,ES02 (default all)  --reps N  --shell powershell|cmd|bash|wsl (default: this OS)
  --temperature T  --seed N (rep r sends N+r-1)  --max-turns N  --max-requests N (default 20)
  --price-in USD  --price-out USD  (per million tokens, for the plan and the report)
  --baseline A0 (report)  --bash-path FILE  --extra-body JSON (merged into each request)
`;

const die = (m) => {
  process.stderr.write(`envshell: ${m}\n`);
  process.exitCode = 2;
};

const defaultShell = () =>
  process.platform === "win32" ? "powershell" : "bash";
const pick = (all, csv, what) => {
  if (!csv) return all;
  const ids = csv.split(",").map((s) => s.trim());
  const bad = ids.filter((i) => !all.includes(i));
  if (bad.length) throw new Error(`unknown ${what}: ${bad.join(", ")}`);
  return ids;
};

/** Refuse a results folder inside the repository. */
export function assertOutside(dir) {
  const rel = path.relative(REPO_ROOT, path.resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    throw new Error(
      `--out ${dir} is inside the repository; results go outside it (for example under the temp folder)`,
    );
}

/** Plan arithmetic, pure. Average turns per run is an assumption (3.5) stated in the output. */
export function planNumbers({
  models,
  arms,
  tasks,
  reps,
  avgTurns = 3.5,
  price,
}) {
  const runs = models.length * arms.length * tasks.length * reps;
  const requests = Math.round(runs * avgTurns);
  // per request: the system text and tool list (about 700 tokens, A0 about 250), the history growing about 250 tokens a turn
  const inPerRun = Array.from(
    { length: Math.round(avgTurns) },
    (_, i) => 700 + 250 * i,
  ).reduce((a, b) => a + b, 0);
  const outPerRun = Math.round(avgTurns * 110);
  const inTok = runs * inPerRun;
  const outTok = runs * outPerRun;
  const usd = price ? (inTok * price.in + outTok * price.out) / 1e6 : null;
  return { runs, requests, inTok, outTok, usd };
}

const priceOf = (v) =>
  v["price-in"] != null && v["price-out"] != null
    ? { in: Number(v["price-in"]), out: Number(v["price-out"]) }
    : undefined;

export async function main(argv, env = process.env) {
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
  try {
    if (cmd === "list") return list();
    if (cmd === "replay") return replay(v, rest);
    if (cmd === "report") return report(v, rest);
    if (cmd === "oracle") return oracle(v, rest);
    if (cmd === "power") return power();
    if (cmd === "selftest") return await selftest(v);
    if (cmd === "plan" || cmd === "run")
      return await run(v, cmd === "run" && v.run === true);
    return die(`unknown command ${cmd}\n\n${HELP}`);
  } catch (e) {
    return die(e.message);
  }
}

function list() {
  process.stdout.write("Tasks\n");
  for (const t of TASKS)
    process.stdout.write(
      `  ${t.id}  ${t.title.padEnd(42)} covers ${t.covers.join(", ")}\n`,
    );
  process.stdout.write("\nArms\n");
  const host = { shell: defaultShell() };
  for (const a of ARM_IDS) {
    const b = buildArm(a, host, "<dir>");
    process.stdout.write(
      `  ${a}  shell ${b.shell}${b.guidanceSha ? `  guidance ${b.guidanceSha}` : ""}${b.hintOn ? "  +hint" : ""}${b.preflightOn ? "  +preflight" : ""}\n`,
    );
  }
  process.stdout.write("\nFailure classes\n");
  for (const [c, d] of Object.entries(CLASSES))
    process.stdout.write(`  ${c.padEnd(15)} ${d}\n`);
  process.stdout.write(
    `\nGuidance texts are placeholders (${Object.keys(GUIDANCE).join(", ")}); see arms.mjs.\n`,
  );
}

function replay(v, rest) {
  const inputs = [...(v.input ?? []), ...rest];
  if (inputs.length === 0)
    throw new Error("replay needs --input PATH (a file or a folder)");
  const found = readCommands(inputs);
  const commands = found.map((f) => f.command);
  const shells =
    v["all-shells"] || !v.shell ? ["powershell", "cmd", "bash"] : [v.shell];
  const sums = shells.map((s) => summarize(commands, s));
  if (v.json)
    return process.stdout.write(
      `${JSON.stringify({ commands: commands.length, unique: new Set(commands).size, summaries: sums }, null, 2)}\n`,
    );
  process.stdout.write(
    `${commands.length} commands read from ${new Set(found.map((f) => f.file)).size} files\n\n`,
  );
  for (const s of sums) process.stdout.write(`${formatSummary(s)}\n\n`);
}

function report(v, rest) {
  const dir = rest[0];
  if (!dir) throw new Error("report needs a results folder");
  const file = fs.statSync(dir).isDirectory()
    ? path.join(dir, "envshell.jsonl")
    : dir;
  const records = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  process.stdout.write(
    `${formatReport(records, { baseline: v.baseline, price: priceOf(v) })}\n`,
  );
}

function oracle(v, rest) {
  const inputs = [...(v.input ?? []), ...rest];
  if (inputs.length === 0) throw new Error("oracle needs --input PATH");
  const commands = [...new Set(readCommands(inputs).map((f) => f.command))];
  const shell = v.shell ?? defaultShell();
  const errors =
    shell === "bash"
      ? bashParseErrors(commands, v["bash-path"])
      : powershellParseErrors(commands);
  const c = confusion(commands, errors, shell);
  const parserRejects = errors.filter(Boolean).length;
  process.stdout.write(
    `${shell} parser vs detector certain signals, ${c.n} unique commands: parser rejects ${parserRejects}; true positive ${c.tp}, false positive ${c.fp}, missed ${c.fn}, true negative ${c.tn}
`,
  );
  const ratio = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
  process.stdout
    .write(`  precision ${ratio(c.tp, c.tp + c.fp)}, recall ${ratio(c.tp, c.tp + c.fn)}
`);
  for (const x of c.falsePositives.slice(0, 10))
    process.stdout.write(`  FALSE POSITIVE: ${JSON.stringify(x.slice(0, 100))}
`);
  for (const x of c.misses.slice(0, 10))
    process.stdout.write(`  MISSED: ${JSON.stringify(x.slice(0, 100))}
`);
}

function power() {
  const rows = [];
  rows.push(
    "Exact power of the paired McNemar test, alpha 0.05, by number of pairs n (task x rep) and discordant pairs.",
  );
  rows.push(
    "onlyB/onlyA are the fractions of pairs solved by one arm only; the difference in success is onlyB - onlyA.",
    "",
  );
  rows.push(
    "| scenario | n=30 | n=60 | n=100 | n=150 | n=250 |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const [name, a, b] of [
    ["diff 0.10 (0.04 / 0.14)", 0.04, 0.14],
    ["diff 0.15 (0.05 / 0.20)", 0.05, 0.2],
    ["diff 0.20 (0.05 / 0.25)", 0.05, 0.25],
    ["diff 0.30 (0.05 / 0.35)", 0.05, 0.35],
    ["diff 0.10, noisy (0.15 / 0.25)", 0.15, 0.25],
  ])
    rows.push(
      `| ${name} | ${[30, 60, 100, 150, 250].map((n) => pairedPower(n, a, b).toFixed(2)).join(" | ")} |`,
    );
  process.stdout.write(`${rows.join("\n")}\n`);
}

/** Run the reference solutions and the naive commands on this host. */
async function selftest(v) {
  const shell = v.shell ?? defaultShell();
  const refs = SOLUTIONS[shell];
  if (!refs)
    throw new Error(
      `no reference solutions for ${shell} (have ${Object.keys(SOLUTIONS).join(", ")})`,
    );
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "envshell-selftest-"));
  assertOutside(base);
  let bad = 0;
  const execOpts = { bashPath: v["bash-path"] };
  for (const t of TASKS) {
    const dir = path.join(base, t.id);
    const token = `tok-${t.id}`;
    const ctx = prepare(t, dir, { token, shell });
    const env = t.env?.(ctx) ?? {};
    const trace = [];
    for (const command of refs[t.id]) {
      const res = await execOnHost(shell, command, {
        cwd: dir,
        env,
        ...execOpts,
      });
      const o = classifyOutcome({ command, shell, ...res });
      trace.push(
        `${o.failed ? `FAILED(${o.cls})` : "ok"} ${(res.stderr || "").split("\n")[0].slice(0, 90)}`,
      );
    }
    const r = t.check(ctx);
    t.cleanup?.(ctx);
    if (!r.pass) bad++;
    process.stdout.write(
      `${r.pass ? "PASS" : "FAIL"} ${t.id} ${t.title}${r.pass ? "" : `: ${r.reasons.join("; ")}`}\n${r.pass ? "" : `     ${trace.join(" | ")}\n`}`,
    );
  }
  process.stdout.write("\nnaive commands (classifier against a real shell)\n");
  for (const n of NAIVE.filter((x) => x.shell === shell)) {
    const dir = path.join(base, "naive");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    const res = await execOnHost(shell, n.command, {
      cwd: dir,
      env: { TASK_TOKEN: "x" },
      ...execOpts,
    });
    const o = classifyOutcome({ command: n.command, shell, ...res });
    process.stdout.write(
      `  ${n.id.padEnd(8)} expect ${n.expect.padEnd(20)} got ${o.failed ? o.cls : `ok${o.silent ? " (silent signal)" : ""}`}  ${(res.stderr || res.stdout).split("\n")[0].slice(0, 80)}\n`,
    );
  }
  fs.rmSync(base, { recursive: true, force: true });
  if (bad) process.exitCode = 1;
}

async function run(v, live) {
  const models = (v.models ?? "").split(",").filter(Boolean);
  if (models.length === 0)
    throw new Error("--models is required (the model id the endpoint serves)");
  const arms = pick(ARM_IDS, v.arms, "arm");
  const tasks = TASKS.filter(
    (t) => !v.tasks || v.tasks.split(",").includes(t.id),
  );
  const reps = Number(v.reps);
  const shell = v.shell ?? defaultShell();
  const price = priceOf(v);
  const p = planNumbers({
    models,
    arms,
    tasks: tasks.map((t) => t.id),
    reps,
    price,
  });
  process.stdout.write(
    `${live ? "RUN" : "DRY PLAN"}: ${models.length} model(s) x ${arms.length} arm(s) x ${tasks.length} task(s) x ${reps} rep(s) = ${p.runs} runs on ${shell}\n` +
      `  about ${p.requests} requests (assuming 3.5 per run), ${p.inTok} input and ${p.outTok} output tokens${p.usd === null ? "" : `, about USD ${p.usd.toFixed(2)} at the given prices`}\n` +
      `  endpoint ${v["base-url"]}, request cap ${v["max-requests"]}\n`,
  );
  if (!live) {
    process.stdout.write(
      "Nothing was sent. Add --run (and --out DIR) to play it.\n",
    );
    return;
  }
  if (!v.out) throw new Error("--out DIR is required with --run");
  assertOutside(v.out);
  const outDir = path.resolve(v.out);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "envshell.jsonl");
  const done = new Set();
  if (fs.existsSync(file))
    for (const l of fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)) {
      const r = JSON.parse(l);
      done.add(`${r.model}|${r.arm}|${r.task}|${r.rep}`);
    }
  let requests = 0;
  const cap = Number(v["max-requests"]);
  const extra = v["extra-body"] ? JSON.parse(v["extra-body"]) : {};
  let stop = false;
  for (const model of models)
    for (let rep = 1; rep <= reps && !stop; rep++)
      for (const arm of arms)
        for (const task of tasks) {
          if (stop) break;
          if (done.has(`${model}|${arm}|${task.id}|${rep}`)) continue;
          const dir = path.join(
            outDir,
            "work",
            model.replace(/[^\w.-]/g, "_"),
            arm,
            `${task.id}-${rep}`,
          );
          const token = `tok-${createHash("sha256").update(`${task.id}:${rep}`).digest("hex").slice(0, 10)}`;
          const chat = async (req) => {
            if (requests >= cap) throw new Error("budget");
            requests++;
            return chatOpenAI({
              baseUrl: v["base-url"],
              model,
              messages: req.messages,
              tools: req.tools,
              temperature: Number(v.temperature),
              seed: Number(v.seed) + rep - 1,
              maxTokens: Number(v["max-tokens"]),
              extra,
            });
          };
          const rec = await runTask({
            task,
            armId: arm,
            host: { shell },
            dir,
            token,
            chat,
            maxTurns: Number(v["max-turns"]),
            model,
            execOpts: { bashPath: v["bash-path"] },
          });
          if (rec.error === "budget") {
            stop = true;
            process.stdout.write(
              `request cap ${cap} reached; stopping before ${arm} ${task.id}\n`,
            );
            break;
          }
          const out = {
            suite: "env-shell",
            model,
            rep,
            at: new Date().toISOString(),
            temperature: Number(v.temperature),
            seed: Number(v.seed) + rep - 1,
            ...rec,
          };
          fs.appendFileSync(file, `${JSON.stringify(out)}\n`);
          process.stdout.write(
            `${arm} ${task.id} rep ${rep}: ${rec.pass ? "pass" : "FAIL"} turns ${rec.turns} commands ${rec.commands} failed ${rec.failedCommands}${rec.reasons.length ? ` (${rec.reasons[0].slice(0, 60)})` : ""}\n`,
          );
        }
  process.stdout.write(
    `\n${requests} requests sent; results ${file}\nreport: node bench/lab/lab.mjs envshell report ${outDir}\n`,
  );
}
