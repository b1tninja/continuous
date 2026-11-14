// node bench/src/envCacheSim.mjs [--json]
//
// Offline simulation of where editor and workspace facts go in a request and
// what each placement does to the prompt cache
// (plans/research/env-workspace-context-and-cache-placement.md, section 4).
// No model, no network, no provider: synthetic sessions with seeded volatility
// are turned into request sequences, a prefix cache is simulated over them,
// and the cost is reported as a multiple of the base input price.
//
// The cache model: a request is a list of blocks; an entry is written at each
// breakpoint (the end of the stable prefix, and the ends of the last two
// persisted messages, like the repo's Anthropic strategy). A request reads the
// longest prefix that equals an entry still alive. Tokens from the end of the
// read up to the last breakpoint are written; tokens after it are uncached.
// This is the ideal behaviour of Anthropic, Bedrock and OpenAI GPT-5.6 explicit
// caching; real providers can miss more (routing, lookback, concurrency).

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Seeded PRNG (mulberry32), so every run of a scenario is identical. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Prices as multiples of the base input price. Output is per output token. */
export const PRICES = {
  "anthropic-5m": { read: 0.1, write: 1.25, ttl: 300, output: 5 },
  "anthropic-1h": { read: 0.1, write: 2.0, ttl: 3600, output: 5 },
  // GPT-5.6 and later, explicit or implicit, 30 minute minimum.
  "openai-56-30m": { read: 0.1, write: 1.25, ttl: 1800, output: 6 },
  // Earlier OpenAI models: no write surcharge; read discount varies, 0.25 used.
  "openai-legacy": { read: 0.25, write: 1.0, ttl: 600, output: 8 },
  // Gemini 4 implicit caching: a previous request is reused in full only when
  // the new request adds at least 2,050 tokens; otherwise the last 2,050 are
  // processed again at the standard rate. Read 0.25 (OpenRouter's figure),
  // no write surcharge; the lifetime is not published, 300 s assumed.
  "gemini4-implicit": {
    read: 0.25,
    write: 1.0,
    ttl: 300,
    output: 8,
    minAdd: 2050,
  },
};

/** Token sizes of the facts, from the repo's goldens and the harness survey. */
export const SIZES = {
  identity: 60, // roots, repo name, branch at start, OS, shell
  activeFile: 20, // path only
  selection: 15, // line range only
  openTabs: 120, // ten paths
  diagnostics: 150, // when present (capped)
  gitStatus: 300, // capped at 40 lines
  time: 20,
  deltaOverhead: 25, // tags and the "changed" sentence
  pullCallOutput: 40, // the model's tool call
  pullResult: 60, // a compact editor-state tool result
};

/**
 * One synthetic session: 30 user turns, each with a tool loop of 1 to 6
 * requests. Returns the list of requests with the true editor state at each.
 */
export function makeSession({ seed = 7, turns = 30, longGapAt = 20 } = {}) {
  const r = prng(seed);
  const reqs = [];
  let state = { active: 0, sel: 0, diag: 0, git: 0, tabs: 0, minute: 0 };
  let t = 0;
  for (let turn = 0; turn < turns; turn++) {
    t += turn === longGapAt ? 480 : 90; // user think time; one 8 minute break
    state = { ...state, minute: Math.floor(t / 60) };
    if (turn > 0 && r() < 0.25)
      state = { ...state, active: state.active + 1, tabs: state.tabs + 1 };
    if (r() < 0.6) state = { ...state, sel: state.sel + 1 };
    const loop = 1 + Math.floor(r() * 6);
    for (let k = 0; k < loop; k++) {
      const first = k === 0;
      const toolResult = first ? 0 : 100 + Math.floor(r() * 1900);
      const edited = !first && r() < 0.4;
      reqs.push({ turn, first, t, toolResult, state: { ...state } });
      if (edited)
        state = { ...state, diag: state.diag + 1, git: state.git + 1 };
      t += 8 + Math.floor(r() * 20);
      state = { ...state, minute: Math.floor(t / 60) };
    }
  }
  return reqs;
}

const VOLATILE = ["active", "sel", "tabs", "diag", "git"];
const FULL_VOLATILE =
  SIZES.activeFile +
  SIZES.selection +
  SIZES.openTabs +
  SIZES.diagnostics +
  SIZES.gitStatus;
const FIELD_SIZE = {
  active: SIZES.activeFile,
  sel: SIZES.selection,
  tabs: SIZES.openTabs,
  diag: SIZES.diagnostics,
  git: SIZES.gitStatus,
};
const key = (s, fields = VOLATILE) =>
  fields.map((f) => `${f}${s[f]}`).join(",");
const changed = (a, b) => VOLATILE.filter((f) => !b || a[f] !== b[f]);

/**
 * The placements of section 3. Each builds the block list of one request from
 * the persisted history and returns the new persisted messages, so the history
 * carries exactly what the placement freezes into it.
 */
export const PLACEMENTS = {
  // Today's CLI: identity in system, a snapshot in the first user message,
  // never updated. Cache-perfect, stale after the first change.
  "A0-snapshot": { snapshot: true },
  // Everything in the system block, re-rendered on every request.
  "A-system-live": { system: true },
  // Re-rendered in the first user message on every request.
  "B-first-user-live": { firstUser: true },
  // Full block on every new user or tool-result message, frozen (Roo, Copilot).
  "C-frozen-every": { frozenEvery: true },
  // Full block on user-typed messages only, frozen (Codex IDE, Claude Code).
  "C-frozen-user": { frozenUser: true },
  // Full block after the last breakpoint on the newest message, not persisted.
  "C-float-tail": { float: true },
  // Changed fields only, appended as a frozen message (Codex, Gemini CLI).
  "D-delta": { delta: true },
  // No bytes; the model pulls state when the active file changed.
  "E-pull": { pull: true },
  // Identity in system; compact delta (path, range, counts); rich data by tool.
  "F-hybrid": { hybrid: true },
};

/** Builds the request sequence of a placement and simulates the cache. */
export function simulate(placementName, session, priceName, opts = {}) {
  const p = PLACEMENTS[placementName];
  const price = PRICES[priceName];
  const prefix = opts.prefixTokens ?? 6000;
  const compactAt = opts.compactAt ?? Infinity;
  const history = []; // {key, tokens}
  let firstUserExtra = 0;
  let firstUserKey = "";
  let lastShown; // state the model last saw
  let n = 0;
  const cache = new Map(); // prefix key -> expiry
  const acc = {
    requests: 0,
    read: 0,
    write: 0,
    uncached: 0,
    output: 0,
    stale: 0,
    envTokens: 0,
  };
  let compactions = 0;

  const run = (blocks, now, outTokens = 0) => {
    // blocks: [{key, tokens, bp}]
    let pk = "";
    const keys = blocks.map((b) => (pk = `${pk}|${b.key}`));
    let readEnd = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const exp = cache.get(keys[i]);
      if (exp !== undefined && exp >= now) {
        readEnd = i;
        break;
      }
    }
    let lastBp = -1;
    blocks.forEach((b, i) => b.bp && (lastBp = i));
    let read = 0;
    let write = 0;
    let unc = 0;
    blocks.forEach((b, i) => {
      if (i <= readEnd) read += b.tokens;
      else if (i <= lastBp) write += b.tokens;
      else unc += b.tokens;
    });
    if (price.minAdd && read > 0 && write + unc < price.minAdd) {
      const shift = Math.min(read, price.minAdd - (write + unc));
      read -= shift;
      unc += shift;
    }
    if (readEnd >= 0) cache.set(keys[readEnd], now + price.ttl);
    blocks.forEach((b, i) => b.bp && cache.set(keys[i], now + price.ttl));
    acc.requests++;
    acc.read += read;
    acc.write += write;
    acc.uncached += unc;
    acc.output += outTokens;
  };

  const historyBlocks = () => {
    const out = history.map((h) => ({
      key: h.key,
      tokens: h.tokens,
      bp: false,
    }));
    for (let i = out.length - 1, marked = 0; i >= 0 && marked < 2; i--) {
      if (history[i].bpCandidate) {
        out[i].bp = true;
        marked++;
      }
    }
    return out;
  };

  for (const req of session) {
    const s = req.state;
    // compaction: history replaced by a summary; summary request reads the old prefix
    const histTokens = history.reduce((a, h) => a + h.tokens, 0);
    if (histTokens > compactAt) {
      compactions++;
      history.length = 0;
      history.push({
        key: `summary${compactions}`,
        tokens: 2500,
        bpCandidate: true,
      });
      if (p.delta || p.hybrid || p.frozenEvery || p.frozenUser)
        lastShown = undefined; // re-send in full
    }

    const sys = { key: `sys`, tokens: prefix, bp: true };
    if (p.system) {
      sys.key = `sys:${key(s)}:${s.minute}`;
      sys.tokens += SIZES.identity + FULL_VOLATILE + SIZES.time;
    } else {
      sys.tokens += SIZES.identity;
    }

    // the new persisted messages of this request
    const msgKey = `m${n++}`;
    const base = req.first
      ? 120 + (history.length ? 250 : 0)
      : 80 + req.toolResult;
    let env = 0;
    let envKey = "";
    if (p.frozenEvery || (p.frozenUser && req.first)) {
      env = FULL_VOLATILE + SIZES.time + SIZES.deltaOverhead;
      envKey = `${key(s)}:${s.minute}`;
      lastShown = s;
    }
    if (p.delta || p.hybrid) {
      const ch = changed(s, lastShown);
      if (ch.length && (req.first || p.delta)) {
        const fieldTokens = ch.reduce(
          (a, f) =>
            a + (p.hybrid ? Math.min(FIELD_SIZE[f], 30) : FIELD_SIZE[f]),
          0,
        );
        env = fieldTokens + SIZES.deltaOverhead;
        envKey = key(s);
        lastShown = s;
      }
    }
    if (p.snapshot && n === 1) {
      firstUserExtra = FULL_VOLATILE;
      firstUserKey = key(s);
      acc.envTokens += FULL_VOLATILE;
      lastShown = s;
    }
    history.push({
      key: `${msgKey}:${envKey}`,
      tokens: base + env,
      bpCandidate: true,
    });
    acc.envTokens += env;

    let blocks = [sys, ...historyBlocks()];
    if (p.snapshot && blocks.length > 1) {
      blocks[1] = {
        ...blocks[1],
        key: `${blocks[1].key}:${firstUserKey}`,
        tokens: blocks[1].tokens + firstUserExtra,
      };
    }
    if (p.firstUser && blocks.length > 1) {
      blocks[1] = {
        ...blocks[1],
        key: `${blocks[1].key}:${key(s)}:${s.minute}`,
        tokens: blocks[1].tokens + FULL_VOLATILE + SIZES.time,
      };
      lastShown = s;
      acc.envTokens += FULL_VOLATILE + SIZES.time;
    }
    if (p.system) {
      lastShown = s;
      acc.envTokens += FULL_VOLATILE + SIZES.time;
    }
    if (p.float) {
      blocks.push({
        key: `tail:${key(s)}:${s.minute}`,
        tokens: FULL_VOLATILE + SIZES.time,
        bp: false,
      });
      lastShown = s;
      acc.envTokens += FULL_VOLATILE + SIZES.time;
    }
    // E: when the active file changed since the model last looked, it pulls
    // (one extra request and a result) before acting; selection changes are
    // not pulled, so they stay stale.
    if (p.pull && req.first && lastShown && s.active !== lastShown.active) {
      run(blocks, req.t, SIZES.pullCallOutput);
      history.push({
        key: `pull${n}`,
        tokens: SIZES.pullCallOutput + SIZES.pullResult,
        bpCandidate: true,
      });
      acc.envTokens += SIZES.pullCallOutput + SIZES.pullResult;
      blocks = [sys, ...historyBlocks()];
      lastShown = { ...s };
    }
    if (p.pull && !lastShown) lastShown = s; // the session starts with what the person typed
    if (
      lastShown &&
      key(lastShown, ["active", "sel", "diag"]) !==
        key(s, ["active", "sel", "diag"])
    ) {
      acc.stale++;
    }
    run(blocks, req.t);
  }

  const cost =
    acc.read * price.read +
    acc.write * price.write +
    acc.uncached +
    acc.output * price.output;
  const input = acc.read + acc.write + acc.uncached;
  return {
    placement: placementName,
    price: priceName,
    requests: acc.requests,
    inputTokens: input,
    readShare: input ? acc.read / input : 0,
    writeTokens: acc.write,
    uncachedTokens: acc.uncached,
    envTokens: acc.envTokens,
    staleShare: acc.stale / session.length,
    compactions,
    cost,
  };
}

/** Every placement under one price, with the cost relative to A0-snapshot. */
export function table(priceName, opts = {}) {
  const session = makeSession(opts);
  const rows = Object.keys(PLACEMENTS).map((name) =>
    simulate(name, session, priceName, opts),
  );
  const baseline = rows.find((r) => r.placement === "A0-snapshot").cost;
  return rows.map((r) => ({ ...r, relCost: r.cost / baseline }));
}

function fmt(rows) {
  const head =
    "| Placement | Requests | Read share | Write tok | Uncached tok | Env tok | Stale share | Cost index | vs A0 |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map(
    (r) =>
      `| ${r.placement} | ${r.requests} | ${(100 * r.readShare).toFixed(1)}% | ${r.writeTokens.toLocaleString("en-US")} | ${r.uncachedTokens.toLocaleString("en-US")} | ${r.envTokens.toLocaleString("en-US")} | ${(100 * r.staleShare).toFixed(0)}% | ${Math.round(r.cost).toLocaleString("en-US")} | ${r.relCost.toFixed(2)}x |`,
  );
  return [head, sep, ...body].join("\n");
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);
if (isMain) {
  const json = process.argv.includes("--json");
  const out = [];
  for (const [label, opts] of [
    ["prefix 6,000, no compaction", { prefixTokens: 6000 }],
    ["prefix 20,000, no compaction", { prefixTokens: 20000 }],
    [
      "prefix 6,000, compaction above 40,000 history tokens",
      { prefixTokens: 6000, compactAt: 40000 },
    ],
  ]) {
    for (const price of Object.keys(PRICES)) {
      const rows = table(price, opts);
      out.push({ label, price, rows });
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  else
    for (const o of out)
      console.log(`\n### ${o.label}, ${o.price}\n\n${fmt(o.rows)}`);
}
