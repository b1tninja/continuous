// Whitespace fidelity of string tool arguments (suite `args-whitespace`).
// vLLM v0.24.0 to v0.25.1 and main strip leading and trailing whitespace from
// every string argument in the Qwen3 and Qwen3-Coder tool parser (vLLM issue
// 48753), which silently breaks exact-string edits. This module compares the
// argument as the harness received it with the string the probe asked for,
// byte for byte, and names the first differing byte. Pure: no I/O, so it runs
// offline on recorded results and online on the records a run just wrote.

import { toServerIdentity } from "./serverIdentity.mjs";

const enc = new TextEncoder();

/** A string with controls escaped and spaces shown as a visible mark. */
export function visible(s) {
  if (typeof s !== "string") return JSON.stringify(s) ?? String(s);
  return JSON.stringify(s).slice(1, -1).replace(/ /g, "␣");
}

/**
 * The first byte (UTF-8) at which `got` differs from `want`, or null when they
 * are identical. `index` is a byte offset; `want` and `got` are the bytes there
 * (null past the end of that side).
 */
export function firstDiff(want, got) {
  const a = enc.encode(want);
  const b = enc.encode(got);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++)
    if (a[i] !== b[i]) return { index: i, want: a[i], got: b[i] };
  if (a.length === b.length) return null;
  return {
    index: n,
    want: a.length > n ? a[n] : null,
    got: b.length > n ? b[n] : null,
  };
}

const hex = (b) => (b == null ? "end" : "0x" + b.toString(16).padStart(2, "0"));

/** What kind of damage: stripped (only edge whitespace lost), changed, or none. */
export function damage(want, got) {
  if (typeof got !== "string") return "not-a-string";
  if (want === got) return "none";
  if (want.trim() === got) return "stripped";
  if (want.trim() === got.trim()) return "edges-changed";
  return "changed";
}

/** Case id without the `@cfg` suffix and the `.native` mode suffix. */
export const probeId = (caseId) =>
  String(caseId)
    .replace(/@.*$/, "")
    .replace(/\.native$/, "");

/** `{probeId: {tool, group, fields: [[name, expected]]}}`: the string arguments a probe checks (`checks` names them; default all). */
export function expectations(suite) {
  const out = {};
  for (const p of suite.probes ?? []) {
    const args = p.expect?.args ?? {};
    out[p.id] = {
      tool: p.expect?.tool,
      group: p.group,
      fields: Object.entries(args).filter(
        ([k, v]) =>
          typeof v === "string" && (!p.checks || p.checks.includes(k)),
      ),
    };
  }
  return out;
}

/** One record scored: one entry per checked field of the expected call. */
export function checkRecord(rec, exp) {
  const call = (rec.calls ?? rec.reply?.toolCalls ?? []).find(
    (c) => c.name === exp.tool,
  );
  const base = { caseId: probeId(rec.caseId), group: exp.group };
  if (!call)
    return exp.fields.map(([field, want]) => ({
      ...base,
      field,
      want,
      called: false,
      exact: false,
      damage: "no-call",
    }));
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return exp.fields.map(([field, want]) => {
    const got = args?.[field];
    const isStr = typeof got === "string";
    const diff = isStr
      ? firstDiff(want, got)
      : { index: 0, want: null, got: null };
    return {
      ...base,
      field,
      want,
      got,
      called: true,
      exact: isStr && diff === null,
      damage: damage(want, got),
      diff: diff ?? undefined,
    };
  });
}

/** The identity of the server a record came from, as the report's row label. */
export function serverLabel(rec) {
  const id = toServerIdentity(rec.engine) ?? { name: "unknown server" };
  const parts = [id.version ? `${id.name} ${id.version}` : id.name];
  if (id.parser) parts.push(`parser ${id.parser} (${id.parserSource})`);
  if (id.templateSha) parts.push(`template ${id.templateSha}`);
  return parts.join(", ");
}

function verdictOf(rows) {
  const stripped = rows.filter((r) => r.damage === "stripped").length;
  const altered = rows.filter(
    (r) => r.called && !r.exact && r.damage !== "stripped",
  ).length;
  if (stripped > 0) return "STRIPS WHITESPACE";
  if (altered > 0) return "ALTERS ARGUMENTS";
  if (rows.some((r) => !r.called))
    return "INCOMPLETE (some replies made no call)";
  return "FAITHFUL";
}

/**
 * Score every record of the suite. Returns one arm per model and server
 * identity: { model, server, rows, n, exact, stripped, verdict }.
 */
export function analyze(records, suite) {
  const exps = expectations(suite);
  const arms = new Map();
  for (const rec of records) {
    if (rec.suite !== suite.suite || rec.outcome === "error") continue;
    const exp = exps[probeId(rec.caseId)];
    if (!exp) continue;
    const server = serverLabel(rec);
    const key = `${rec.model}\u0000${server}`;
    if (!arms.has(key)) arms.set(key, { model: rec.model, server, rows: [] });
    arms.get(key).rows.push(...checkRecord(rec, exp));
  }
  return [...arms.values()].map((a) => ({
    ...a,
    n: a.rows.length,
    exact: a.rows.filter((r) => r.exact).length,
    stripped: a.rows.filter((r) => r.damage === "stripped").length,
    verdict: verdictOf(a.rows),
  }));
}

/** Markdown: per arm a verdict and a per-case table with the first differing byte. */
export function formatWhitespaceReport(arms) {
  if (!arms.length) return "No `args-whitespace` records found.\n";
  const out = [
    "# String argument whitespace fidelity",
    "",
    "Each case asks for an `edit_file` call with an exact `old_string`. `exact` means the argument as received equals the expected string byte for byte. `stripped` means only leading or trailing whitespace was lost (vLLM issue 48753). The first differing byte is a UTF-8 offset.",
    "",
  ];
  for (const a of arms) {
    out.push(
      `## ${a.model} on ${a.server}`,
      "",
      `Verdict: **${a.verdict}** (${a.exact}/${a.n} fields exact, ${a.stripped} stripped)`,
      "",
      "| case | field | exact | damage | first differing byte | expected | received |",
      "| ---- | ----- | ----- | ------ | -------------------- | -------- | -------- |",
    );
    for (const r of a.rows) {
      const d = r.diff
        ? `#${r.diff.index}: expected ${hex(r.diff.want)}, got ${hex(r.diff.got)}`
        : "-";
      const got = r.called ? `\`${visible(r.got)}\`` : "(no call)";
      out.push(
        `| ${r.caseId} | ${r.field} | ${r.exact ? "yes" : "no"} | ${r.damage} | ${d} | \`${visible(r.want)}\` | ${got} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}
