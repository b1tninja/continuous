#!/usr/bin/env node
/**
 * Run the act and plan turn-prompt evaluation (core/llm/prompts/evaluation)
 * against a model and print the quality-bar report, per prompt profile.
 *
 *   npm run eval:turns -- --help
 *
 * This is a thin wrapper around live.vitest.ts, which reads the TURNS_EVAL_*
 * environment variables. It adds flags, a check that you meant to call a
 * hosted API, and an exit code. Same shape as scripts/reviewer-eval.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUBS = ["oracle", "text-only"];

const HELP = `Usage: npm run eval:turns -- [options]

Sends five fixed conversations (two act turns, three plan turns) to a model under
each prompt profile (full, short) and scores the first reply: which tool it calls,
what it must not call, what it must not say. Nothing it calls is run. Prints the
quality-bar report per profile.

Model (pick one way):
  --provider openai --model <id> [--base-url <url>]   OpenAI or any OpenAI-compatible server with tool calling
  --provider anthropic --model <id>                   Anthropic Messages API
  --provider bedrock --model <id> [--region us-east-1] [--aws-profile <name>]
                                                      Amazon Bedrock through core's provider (AWS credential chain)
  --ollama --model <name> [--host http://localhost:11434]   local Ollama (no key, no cost)

Options:
  --profile full|short|tailored|both|all   Which prompt texts to send (default both: full and short;
                         all adds tailored, the Qwen coder text, which reads the model id)
  --runs <n>             Repeat every scenario under every profile n times (default 1); the
                         report shows passes per scenario and the bar is a rate over all runs.
                         Five is the practitioner minimum for a temperature-0 eval.
  --max-tokens <n>       Output budget per reply (default 4000). On Bedrock, reasoning tokens
                         count against it: AWS suggests about 15000 at low and 30000 at medium
                         for Nova 2, and a cut-off reply is reported as such, not as text only.
  --reasoning off|low|medium|high   Switch the model's reasoning on at this effort (default off):
                         Bedrock gets the family's own switch through core, OpenAI-compatible
                         servers reasoning_effort, Anthropic a thinking budget
  --api-key-env <NAME>   Environment variable that holds the key
                         (default OPENAI_API_KEY, or ANTHROPIC_API_KEY for anthropic)
  --yes                  Confirm you mean to call a hosted API. Required unless the
                         server is on localhost: a full run is 10 requests and is
                         billed by the provider.
  --strict               Exit 1 if the report does not meet the bar
  --out <file>           Also write the markdown report to a file
  --dump <file>          Also write every reply (text, calls, failures) as JSON, for reading
                         what a model said before tuning a scenario
  --stub ${STUBS.join("|")}   Run with a stand-in instead of a model (no network;
                         checks that the harness and the bar work)
  -h, --help

Environment (alternative to flags): TURNS_EVAL_PROVIDER, TURNS_EVAL_MODEL,
TURNS_EVAL_BASE_URL, TURNS_EVAL_API_KEY, TURNS_EVAL_REGION, TURNS_EVAL_AWS_PROFILE,
TURNS_EVAL_PROFILES, TURNS_EVAL_REASONING, TURNS_EVAL_RUNS, TURNS_EVAL_MAX_TOKENS, TURNS_EVAL_OUT,
TURNS_EVAL_DUMP.

Examples:
  npm run eval:turns -- --stub oracle --strict
  npm run eval:turns -- --ollama --model qwen3:8b --out qwen3.md
  OPENAI_API_KEY=... npm run eval:turns -- --provider openai --model gpt-4.1-mini --yes --strict
  ANTHROPIC_API_KEY=... npm run eval:turns -- --provider anthropic --model claude-haiku-4-5 --yes
  npm run eval:turns -- --provider bedrock --model us.amazon.nova-2-lite-v1:0 --aws-profile torgate --yes --dump nova.json
`;

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "--provider":
        o.provider = next();
        break;
      case "--model":
        o.model = next();
        break;
      case "--base-url":
        o.baseUrl = next();
        break;
      case "--host":
        o.host = next();
        break;
      case "--region":
        o.region = next();
        break;
      case "--aws-profile":
        o.awsProfile = next();
        break;
      case "--dump":
        o.dump = next();
        break;
      case "--ollama":
        o.ollama = true;
        break;
      case "--api-key-env":
        o.keyEnv = next();
        break;
      case "--profile":
        o.profile = next();
        break;
      case "--reasoning":
        o.reasoning = next();
        break;
      case "--runs":
        o.runs = next();
        break;
      case "--max-tokens":
        o.maxTokens = next();
        break;
      case "--yes":
        o.yes = true;
        break;
      case "--strict":
        o.strict = true;
        break;
      case "--out":
        o.out = next();
        break;
      case "--stub":
        o.stub = next();
        break;
      default:
        fail(`Unknown option ${a}. Try --help.`);
    }
  }
  return o;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const isLocal = (url) => {
  try {
    const h = new URL(url).hostname;
    return (
      h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"
    );
  } catch {
    return false;
  }
};

const opts = parse(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const env = { ...process.env };
let target;

if (opts.profile) {
  if (!["full", "short", "tailored", "both", "all"].includes(opts.profile)) {
    fail("--profile must be full, short, tailored, both or all");
  }
  env.TURNS_EVAL_PROFILES =
    opts.profile === "both"
      ? "full,short"
      : opts.profile === "all"
        ? "full,short,tailored"
        : opts.profile;
}

if (opts.maxTokens !== undefined) {
  const n = Number(opts.maxTokens);
  if (!Number.isInteger(n) || n < 256 || n > 200000) {
    fail("--max-tokens must be a whole number from 256 to 200000");
  }
  env.TURNS_EVAL_MAX_TOKENS = String(n);
}

if (opts.runs !== undefined) {
  const n = Number(opts.runs);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    fail("--runs must be a whole number from 1 to 50");
  }
  env.TURNS_EVAL_RUNS = String(n);
}

if (opts.reasoning) {
  if (!["off", "low", "medium", "high"].includes(opts.reasoning)) {
    fail("--reasoning must be off, low, medium or high");
  }
  if (opts.reasoning === "off") delete env.TURNS_EVAL_REASONING;
  else env.TURNS_EVAL_REASONING = opts.reasoning;
}

if (opts.stub) {
  if (!STUBS.includes(opts.stub)) {
    fail(`--stub must be ${STUBS.join(" or ")}`);
  }
  env.TURNS_EVAL_STUB = opts.stub;
  target = `stub:${opts.stub}`;
} else {
  let provider =
    opts.provider ?? env.TURNS_EVAL_PROVIDER ?? (opts.ollama ? "openai" : "");
  const model = opts.model ?? env.TURNS_EVAL_MODEL;
  if (!model) fail("Give a model with --model (or use --stub). See --help.");
  if (!provider) fail("Give --provider openai|anthropic|bedrock, or --ollama.");
  if (!["openai", "anthropic", "bedrock"].includes(provider)) {
    fail("--provider must be openai, anthropic or bedrock");
  }
  // The wrapper's checks (--yes before a billed API) are the consent the live
  // test asks for; without this flag the test setup removes provider credentials.
  env.RUN_LIVE_PROVIDER_TESTS = "1";

  if (provider === "bedrock") {
    // Credentials come from the AWS chain (a profile, the environment, SSO),
    // not from a key variable; the run is hosted and billed all the same.
    const region = opts.region ?? env.TURNS_EVAL_REGION ?? "us-east-1";
    if (!opts.yes) {
      fail(
        `This sends ${10 * Number(env.TURNS_EVAL_RUNS ?? 1)} requests to Bedrock in ${region}, which AWS bills.\n` +
          "Re-run with --yes to go ahead.",
      );
    }
    env.TURNS_EVAL_PROVIDER = provider;
    env.TURNS_EVAL_MODEL = model;
    env.TURNS_EVAL_REGION = region;
    const awsProfile = opts.awsProfile ?? env.TURNS_EVAL_AWS_PROFILE;
    if (awsProfile) env.TURNS_EVAL_AWS_PROFILE = awsProfile;
    target = `bedrock:${model} (${region}${awsProfile ? `, profile ${awsProfile}` : ""})`;
  } else {
    let baseUrl = opts.baseUrl ?? env.TURNS_EVAL_BASE_URL;
    if (opts.ollama) {
      baseUrl = `${(opts.host ?? "http://localhost:11434").replace(/\/$/, "")}/v1`;
    }
    const effectiveUrl =
      baseUrl ??
      (provider === "anthropic"
        ? "https://api.anthropic.com"
        : "https://api.openai.com/v1");

    const local = isLocal(effectiveUrl);
    const keyName =
      opts.keyEnv ??
      (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
    const key = env.TURNS_EVAL_API_KEY ?? env[keyName] ?? "";

    if (!local) {
      if (!key) fail(`No API key: set ${keyName} (or TURNS_EVAL_API_KEY).`);
      if (!opts.yes) {
        fail(
          `This sends ${10 * Number(env.TURNS_EVAL_RUNS ?? 1)} requests to ${new URL(effectiveUrl).host}, which the provider bills.\n` +
            "Re-run with --yes to go ahead, or use --ollama / a localhost --base-url.",
        );
      }
    }

    env.TURNS_EVAL_PROVIDER = provider;
    env.TURNS_EVAL_MODEL = model;
    if (baseUrl) env.TURNS_EVAL_BASE_URL = baseUrl;
    if (key) env.TURNS_EVAL_API_KEY = key;
    target = `${provider}:${model}${local ? " (local)" : ""}`;
  }
}

const dir = mkdtempSync(join(tmpdir(), "turns-eval-"));
const resultFile = join(dir, "result.json");
env.TURNS_EVAL_RESULT = resultFile;
if (opts.out) env.TURNS_EVAL_OUT = resolve(opts.out);
if (opts.dump) env.TURNS_EVAL_DUMP = resolve(opts.dump);

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
console.error(`Running the turn-prompt evaluation against ${target} ...`);
const run = spawnSync(
  "npx",
  ["vitest", "run", "llm/prompts/evaluation/live.vitest.ts", "--reporter=dot"],
  {
    cwd: coreDir,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);

let passed;
if (existsSync(resultFile)) {
  try {
    passed = JSON.parse(readFileSync(resultFile, "utf8")).passed;
  } catch {
    // fall through
  }
}
rmSync(dir, { recursive: true, force: true });

if (run.status !== 0 || passed === undefined) {
  console.error("The evaluation did not complete (see the output above).");
  process.exit(run.status || 1);
}
console.error(
  passed
    ? "Quality bar: met."
    : `Quality bar: NOT met.${opts.strict ? "" : " (pass --strict to fail the exit code)"}`,
);
process.exit(opts.strict && !passed ? 1 : 0);
