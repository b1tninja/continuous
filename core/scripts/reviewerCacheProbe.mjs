#!/usr/bin/env node
/**
 * Reviewer cache probe (plans/reviewer-audit.md, row U0b): replay a session of
 * reviews through the reviewer's request shape and read the provider's cache
 * usage fields.
 *
 *   node scripts/reviewerCacheProbe.mjs --help
 *
 * Without --run this prints what it would send and exits: no request is made
 * and no key is read. The key is taken from an environment variable and handed
 * to the test process; its value is never printed.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: node scripts/reviewerCacheProbe.mjs --provider <p> --model <id> [options]

Sends a replayed session of reviews (the evaluation's labelled calls, with a
growing history) to a model once per arm and reports cache read share, latency
and agreement. Every request is billed by the provider.

Providers and the variable that holds the credential by default:
  anthropic   ANTHROPIC_API_KEY          Messages API, cache_control markers
  bedrock     AWS_BEARER_TOKEN_BEDROCK   Converse API, cachePoint markers (--region)
  openai      OPENAI_API_KEY             Chat Completions, implicit caching; also
                                         any OpenAI-compatible server via --base-url

Options:
  --run               Required. Without it the plan is printed and nothing is sent.
  --provider, --model Required.
  --arms A,B,C        Arms to run (default A,B,C). A: shipped prompt, no markers.
                      B: marker on the system prompt. C: reordered prompt, two markers.
  --calls N           Reviews per arm (default 60)
  --gap-sec N         Seconds between reviews (default 2; use 360 to see a 5-minute lifetime expire)
  --ttl 1h            Ask for the one-hour lifetime (Claude only)
  --region R          Bedrock region (default us-east-1)
  --base-url URL      Override the host
  --key-env NAME      Read the credential from this variable instead
  --out FILE          Write one CSV row per review (put it outside the repository)
  -h, --help

Not built: the fork-the-main-prefix control arm (D), GPT-5.6 explicit breakpoints, Gemini.
Each arm adds a salt line to the system prompt so arms never read each other's cache.
`;

const DEFAULT_KEY = {
  anthropic: "ANTHROPIC_API_KEY",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK",
  openai: "OPENAI_API_KEY",
};

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

export function parse(argv) {
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
      case "--run":
        o.run = true;
        break;
      case "--provider":
        o.provider = next();
        break;
      case "--model":
        o.model = next();
        break;
      case "--arms":
        o.arms = next();
        break;
      case "--calls":
        o.calls = next();
        break;
      case "--gap-sec":
        o.gapSec = next();
        break;
      case "--ttl":
        o.ttl = next();
        break;
      case "--region":
        o.region = next();
        break;
      case "--base-url":
        o.baseUrl = next();
        break;
      case "--key-env":
        o.keyEnv = next();
        break;
      case "--out":
        o.out = next();
        break;
      default:
        fail(`Unknown option ${a}. Try --help.`);
    }
  }
  return o;
}

/** Check the options and return the settings; exits with 2 on a bad one. */
export function plan(o, env) {
  if (!o.provider || !(o.provider in DEFAULT_KEY)) {
    fail("Give --provider anthropic|bedrock|openai.");
  }
  if (!o.model) fail("Give a model with --model.");
  const arms = (o.arms ?? "A,B,C").split(",").map((s) => s.trim());
  if (arms.some((a) => !["A", "B", "C"].includes(a))) {
    fail("--arms takes A, B and C, comma separated.");
  }
  const calls = Number(o.calls ?? 60);
  const gapSec = Number(o.gapSec ?? 2);
  if (!Number.isInteger(calls) || calls < 1) fail("--calls must be a number.");
  if (!Number.isFinite(gapSec) || gapSec < 0)
    fail("--gap-sec must be a number.");
  if (o.ttl && o.ttl !== "1h") fail("--ttl takes 1h.");
  const keyName = o.keyEnv ?? DEFAULT_KEY[o.provider];
  let host = o.baseUrl;
  if (host) {
    try {
      host = new URL(host).host;
    } catch {
      fail("--base-url is not a URL.");
    }
  }
  return {
    ...o,
    arms,
    calls,
    gapSec,
    keyName,
    keySet: Boolean(env[keyName]),
    host:
      host ??
      {
        anthropic: "api.anthropic.com",
        bedrock: `bedrock-runtime.${o.region ?? "us-east-1"}.amazonaws.com`,
        openai: "api.openai.com",
      }[o.provider],
    requests: arms.length * calls,
  };
}

export function describePlan(p) {
  const minutes = Math.round((p.requests * p.gapSec) / 60);
  return [
    `Plan: ${p.provider}:${p.model} at ${p.host}`,
    `  arms ${p.arms.join(",")}, ${p.calls} reviews each, ${p.requests} billed requests, ${p.gapSec}s apart (about ${minutes} minutes of waiting)`,
    `  credential: variable ${p.keyName} is ${p.keySet ? "set" : "NOT set"} (its value is never printed)`,
    p.out ? `  CSV: ${resolve(p.out)}` : "  CSV: not written (add --out)",
  ].join("\n");
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }
  const p = plan(opts, process.env);
  console.error(describePlan(p));
  if (!p.run) {
    console.error(
      "\nNothing was sent. Add --run to make these requests (the provider bills them).",
    );
    process.exit(0);
  }
  if (!p.keySet) fail(`Set ${p.keyName} (or pass --key-env).`);

  const env = { ...process.env };
  env.REVIEWER_PROBE_RUN = "1";
  // The wrapper's checks (--yes before a billed API) are the consent the live
  // test asks for; without this flag the test setup removes provider credentials.
  env.RUN_LIVE_PROVIDER_TESTS = "1";
  env.REVIEWER_PROBE_PROVIDER = p.provider;
  env.REVIEWER_PROBE_MODEL = p.model;
  env.REVIEWER_PROBE_CREDENTIAL = process.env[p.keyName];
  env.REVIEWER_PROBE_ARMS = p.arms.join(",");
  env.REVIEWER_PROBE_CALLS = String(p.calls);
  env.REVIEWER_PROBE_GAP_MS = String(Math.round(p.gapSec * 1000));
  if (p.ttl) env.REVIEWER_PROBE_TTL = p.ttl;
  if (p.region) env.REVIEWER_PROBE_REGION = p.region;
  if (p.baseUrl) env.REVIEWER_PROBE_BASE_URL = p.baseUrl;
  if (p.out) env.REVIEWER_PROBE_OUT = resolve(p.out);

  const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const res = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "tools/permissions/auto/evaluation/cacheProbe.live.vitest.ts",
      "--reporter=dot",
    ],
    {
      cwd: coreDir,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    },
  );
  process.exit(res.status ?? 1);
}
