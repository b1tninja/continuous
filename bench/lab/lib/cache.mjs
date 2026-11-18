// The `cache` suite: ordered request sequences, not single cases. Each request
// records the engine's own counters:
//   llama-server  timings.cache_n (prompt tokens reused), timings.prompt_n
//                 (prompt tokens evaluated), timings.prompt_ms
//   Ollama        prompt_eval_count, prompt_eval_duration (a cached prefix
//                 shows as a lower count; this is read from responses, not
//                 assumed: see README "What could not be verified")
// Comparisons are inside one sequence on one engine. Never across engines:
// they count tokens differently.
import { toolSet } from "./suites.mjs";
import { Budget, modelGuard, sleep } from "./guards.mjs";
import { LabError } from "./ollama.mjs";
import { appendRecord, resultFile } from "./results.mjs";
import { probeThink, thinkRefusal } from "./probe.mjs";
import { temperatureToSend } from "./sampling.mjs";

const stamp = (n) => `2026-11-10T10:00:${String(n).padStart(2, "0")}Z`;

/**
 * Sequences as data: [{ id, arm, steps: [{ label, messages, tools }] }].
 * `nonce` is the first thing in every system text so a rerun never finds the
 * previous run's cache warm; it is identical inside a sequence, so it never
 * hides the reuse being measured.
 */
export function expandCache(suite, { nonce, agentTools } = {}) {
  const real = toolSet("agent", agentTools);
  const sys = (tag, extra = "", where = "none") => {
    const head = `[cache-lab ${nonce} ${tag}]`;
    const body = suite.system;
    if (where === "first") return `${head}\n${extra}\n${body}`;
    if (where === "last") return `${head}\n${body}\n${extra}`;
    return `${head}\n${body}`;
  };
  const msgs = (s, u) => [
    { role: "system", content: s },
    { role: "user", content: u },
  ];
  const [A, B] = suite.prompts;
  const out = [];
  out.push({
    id: "same-prefix",
    arm: "default",
    steps: [
      { label: "cold", messages: msgs(sys("sp"), A), tools: real },
      { label: "repeat-1", messages: msgs(sys("sp"), A), tools: real },
      { label: "repeat-2", messages: msgs(sys("sp"), A), tools: real },
      {
        label: "new-last-user-message",
        messages: msgs(sys("sp"), B),
        tools: real,
      },
    ],
  });
  for (const where of ["first", "last"])
    out.push({
      id: "volatile-first-vs-last",
      arm: `volatile-${where}`,
      steps: [1, 2, 3].map((n) => ({
        label: n === 1 ? "cold" : `time-changed-${n - 1}`,
        messages: msgs(
          sys(`vol-${where}`, `Current time: ${stamp(n)}`, where),
          A,
        ),
        tools: real,
      })),
    });
  const reversed = [...real].reverse();
  out.push({
    id: "tool-reorder",
    arm: "default",
    steps: [
      { label: "cold", messages: msgs(sys("tr"), A), tools: real },
      { label: "same-order", messages: msgs(sys("tr"), A), tools: real },
      {
        label: "reversed-order",
        messages: msgs(sys("tr"), A),
        tools: reversed,
      },
      {
        label: "original-order-again",
        messages: msgs(sys("tr"), A),
        tools: real,
      },
    ],
  });
  return out;
}

export const cacheRequestCount = (suite) =>
  expandCache(suite, { nonce: "n" }).reduce((n, s) => n + s.steps.length, 0);

export function cacheRecord({
  suiteName = "cache",
  model,
  cfg,
  engine,
  nonce,
  seq,
  step,
  i,
  reply,
  error,
  ms,
}) {
  const u = reply?.usage ?? {};
  return {
    ts: new Date().toISOString(),
    suite: suiteName,
    kind: "cache",
    model,
    api: cfg.api,
    cfg,
    // what the request carried ("inherited" when no sampling option was sent)
    sampling: reply?.meta?.request?.sampling,
    engine,
    run: nonce,
    seq: seq.id,
    arm: seq.arm,
    step: i,
    label: step.label,
    toolCount: step.tools.length,
    toolNames: step.tools.map((t) => t.name).slice(0, 3),
    promptChars: step.messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0,
    ),
    firstChangedChars: step.firstChanged,
    source: step.source,
    usage: u,
    sidecar: reply?.sidecar,
    ms,
    error: error
      ? { kind: error.kind, message: String(error.message).slice(0, 300) }
      : undefined,
    reply: reply && {
      text: reply.text.slice(0, 200),
      doneReason: reply.doneReason,
    },
  };
}

/**
 * Run the sequences for each model. Same guards as runSuite: budget, abort,
 * exclusive model, unload at the end. One request at a time, in order (the
 * order is the experiment).
 */
export async function runCache({
  client,
  suite,
  models,
  roots,
  budget = new Budget({ maxRequests: 40 }),
  signal,
  log = () => {},
  facts,
  limits = {},
  cfg,
  stream = false,
  agentTools,
  numCtx,
  cooldownMs = 0,
  suiteName = "cache",
  buildSequences,
}) {
  const file = resultFile(roots, suiteName);
  const summary = { ran: 0, errors: 0, refused: [], stopped: null, file };
  for (const m of models) {
    if (signal?.aborted) {
      summary.stopped = "interrupted";
      break;
    }
    const guard = modelGuard(
      {
        name: m.name,
        sizeBytes: m.size,
        capabilities: m.capabilities,
        family: m.family,
      },
      limits,
      facts,
    );
    if (!guard.ok) {
      summary.refused.push({ model: m.name, reasons: guard.reasons });
      log(`REFUSED ${m.name}: ${guard.reasons.join("; ")}`);
      continue;
    }
    try {
      const loaded = ((await client.ps()).models ?? [])
        .map((x) => x.name)
        .filter((n) => n !== m.name);
      if (loaded.length) {
        summary.refused.push({
          model: m.name,
          reasons: [`another model is loaded: ${loaded.join(", ")}`],
        });
        log(`REFUSED ${m.name}: another model is loaded: ${loaded.join(", ")}`);
        continue;
      }
    } catch (e) {
      summary.stopped = `cannot reach the engine: ${e.message}`;
      break;
    }
    let engine = await client.describe?.(m.name).catch(() => undefined);
    const probe = await probeThink({
      client,
      model: m.name,
      cfg,
      budget,
      signal,
    }).catch((e) =>
      e.kind === "aborted" ? { aborted: true } : Promise.reject(e),
    );
    if (probe.aborted) {
      summary.stopped = "interrupted";
      await client.unload(m.name);
      break;
    }
    if (probe.ok === false) {
      summary.stopped = thinkRefusal(m.name, probe);
      summary.thinkRefused = { model: m.name, message: probe.message };
      log(`REFUSED ${summary.stopped}`);
      await client.unload(m.name);
      break;
    }
    if (probe.ok) engine = { ...engine, thinkProbe: "accepted" };
    const nonce = Date.now().toString(36);
    const seqs = buildSequences
      ? buildSequences({ nonce })
      : expandCache(suite, { nonce, agentTools });
    let consecutive = 0;
    try {
      outer: for (const seq of seqs)
        for (const [i, step] of seq.steps.entries()) {
          if (signal?.aborted) {
            summary.stopped = "interrupted";
            break outer;
          }
          const why = budget.exhausted();
          if (why) {
            summary.stopped = why;
            break outer;
          }
          const t0 = Date.now();
          let reply, error;
          try {
            budget.spend(1);
            reply = await client.chat({
              model: m.name,
              messages: step.messages,
              tools: step.tools,
              stream,
              options: {
                temperature: temperatureToSend(cfg, suite.defaults.temperature),
                num_predict: cfg.numPredict ?? suite.defaults.numPredict,
                num_ctx: numCtx,
                seed: cfg.seed,
              },
              think: cfg.think,
              toolChoice: cfg.toolChoice,
              bodyExtra: cfg.bodyExtra,
              api: cfg.api,
              keepAlive: "2m",
            });
            consecutive = 0;
          } catch (e) {
            if (!(e instanceof LabError)) throw e;
            if (e.kind === "aborted") {
              summary.stopped = "interrupted";
              break outer;
            }
            error = e;
            consecutive++;
          }
          const rec = cacheRecord({
            suiteName,
            model: m.name,
            cfg,
            engine,
            nonce,
            seq,
            step,
            i,
            reply,
            error,
            ms: Date.now() - t0,
          });
          appendRecord(file, rec, roots);
          error ? summary.errors++ : summary.ran++;
          log(
            `${suiteName} ${seq.id}/${seq.arm} #${i} ${step.label}: ${error ? "error " + error.message : cacheCells(rec).join(" ")}`,
          );
          if (consecutive >= 3) {
            summary.stopped = `3 consecutive errors; last: ${error.message}`;
            break outer;
          }
        }
    } finally {
      await client.unload(m.name);
    }
    if (summary.stopped) break;
    await sleep(cooldownMs, signal);
  }
  return summary;
}

/** One short cell for the slot and metrics sidecar of a request. */
export function sidecarCell(sc) {
  if (!sc) return "-";
  const bits = [];
  const s0 = sc.slots?.[0];
  if (s0)
    bits.push(
      "slot0 " +
        Object.entries(s0)
          .filter(([k, v]) => k !== "next_token" && k !== "id" && v != null)
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    );
  if (sc.metrics?.prompt_tokens_total != null)
    bits.push(`prompt_tokens_total=${sc.metrics.prompt_tokens_total}`);
  if (sc.metrics?.n_tokens_max != null)
    bits.push(`n_tokens_max=${sc.metrics.n_tokens_max}`);
  if (sc.slotsError) bits.push(`slots: ${sc.slotsError}`);
  if (sc.metricsError) bits.push(`metrics: ${sc.metricsError}`);
  return bits.join("; ") || "-";
}

const f0 = (x) => (x == null ? "-" : Math.round(x));
function cacheCells(r) {
  const u = r.usage ?? {};
  return [
    `prompt=${f0(u.promptTokens)}`,
    `cached=${f0(u.cachedTokens)}`,
    `evaluated=${f0(u.promptEvalTokens ?? u.promptTokens)}`,
    `promptMs=${f0(u.promptEvalMs)}`,
    ...(r.sidecar ? [sidecarCell(r.sidecar)] : []),
  ];
}

/** Markdown: one table per engine/model/sequence/arm, per request. */
export function buildCacheReport(records) {
  const recs = records.filter((r) => r.kind === "cache");
  if (!recs.length) return "";
  const L = ["# Cache suite", ""];
  L.push(
    "Counters are the engine's own. `cached` is llama-server `timings.cache_n`; Ollama reports no cached count, so `evaluated` (prompt_eval_count) falling against the first request is its signal. `evaluated vs cold` is evaluated divided by the cold request's. Compare rows inside one table only.",
    "",
  );
  const groups = new Map();
  for (const r of recs) {
    const k = [r.model, r.api, r.run, r.seq, r.arm].join("\u0000");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const rs of groups.values()) {
    rs.sort((a, b) => a.step - b.step);
    const r0 = rs[0];
    L.push(
      `## ${r0.seq}${r0.arm !== "default" ? ` (${r0.arm})` : ""}: ${r0.model} via ${r0.api}`,
      "",
    );
    const hasFc = rs.some((r) => r.firstChangedChars != null);
    const hasSc = rs.some((r) => r.sidecar);
    L.push(
      "| # | step | prompt tokens | cached | evaluated | evaluated vs cold | prompt ms | ttft ms | output tokens |" +
        (hasFc ? " first changed char |" : "") +
        (hasSc ? " slot / metrics |" : ""),
    );
    L.push(
      "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |" +
        (hasFc ? " ---: |" : "") +
        (hasSc ? " --- |" : ""),
    );
    const cold = rs[0].usage?.promptEvalTokens ?? rs[0].usage?.promptTokens;
    for (const r of rs) {
      const u = r.usage ?? {};
      const ev = u.promptEvalTokens ?? u.promptTokens;
      L.push(
        `| ${r.step} | ${r.label} | ${f0(u.promptTokens)} | ${f0(u.cachedTokens)} | ${f0(ev)} | ${ev != null && cold ? (ev / cold).toFixed(2) : "-"} | ${f0(u.promptEvalMs)} | ${f0(u.ttftMs)} | ${f0(u.outputTokens)} |${hasFc ? ` ${r.firstChangedChars ?? "-"} |` : ""}${hasSc ? ` ${sidecarCell(r.sidecar)} |` : ""}${r.error ? " error: " + r.error.message : ""}`,
      );
    }
    L.push("");
  }
  return L.join("\n");
}
