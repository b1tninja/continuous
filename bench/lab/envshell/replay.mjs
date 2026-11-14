// Offline replay: classify RECORDED commands with the dialect detector, no
// model call and no shell. Answers "how often would a command like these be
// written for the wrong shell", per target shell. The recorded set may be a
// bench run dump, a capture fixture, or any JSON, JSONL or TS file that holds
// `command` fields. Pure except `readCommands`, which reads files.
import fs from "node:fs";
import path from "node:path";
import { CLASSES, dialectSignals } from "./classify.mjs";

/** Every string stored under a key named `command` in a parsed JSON value. */
export function commandsInJson(value, out = []) {
  if (Array.isArray(value)) for (const v of value) commandsInJson(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "command" || k === "cmd") && typeof v === "string")
        out.push(v);
      else if (
        typeof v === "string" &&
        /^[{[]/.test(v.trim()) &&
        v.includes('"command"')
      ) {
        // a tool call whose arguments are a JSON string
        try {
          commandsInJson(JSON.parse(v), out);
        } catch {
          /* not JSON */
        }
      } else commandsInJson(v, out);
    }
  }
  return out;
}

/** Commands in a text file: JSON, JSONL, or `command: "..."` literals in TypeScript. */
export function commandsInText(text, ext) {
  const out = [];
  if (ext === ".jsonl") {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        commandsInJson(JSON.parse(line), out);
      } catch {
        /* skip a bad line */
      }
    }
    return out;
  }
  if (ext === ".json") {
    try {
      return commandsInJson(JSON.parse(text), out);
    } catch {
      return out;
    }
  }
  for (const m of text.matchAll(
    /\bcommand:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g,
  )) {
    try {
      out.push(
        m[1][0] === '"'
          ? JSON.parse(m[1])
          : m[1].slice(1, -1).replace(/\\'/g, "'"),
      );
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Walk files and folders; return { file, command } for every command found. */
export function readCommands(inputs) {
  const found = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        if (e === "node_modules" || e === ".git") continue;
        walk(path.join(p, e));
      }
    } else if (/\.(jsonl?|ts|mjs)$/.test(p) && st.size < 20e6) {
      for (const c of commandsInText(
        fs.readFileSync(p, "utf8"),
        path.extname(p),
      ))
        found.push({ file: p, command: c });
    }
  };
  for (const i of inputs) walk(i);
  return found;
}

/**
 * The distribution for one target shell: how many commands carry a signal of
 * another dialect, how many a certain one, by class and by code. Duplicate
 * commands are counted once (`unique: true`).
 */
export function summarize(commands, shell, { unique = true } = {}) {
  const list = unique ? [...new Set(commands)] : commands;
  const byClass = {};
  const byCode = {};
  let withSignal = 0;
  let certain = 0;
  for (const c of list) {
    const sigs = dialectSignals(c, shell);
    if (sigs.length === 0) continue;
    withSignal++;
    if (sigs.some((s) => s.certain)) certain++;
    for (const cls of new Set(sigs.map((s) => s.cls)))
      byClass[cls] = (byClass[cls] ?? 0) + 1;
    for (const s of sigs) byCode[s.code] = (byCode[s.code] ?? 0) + 1;
  }
  return { shell, n: list.length, withSignal, certain, byClass, byCode };
}

export function formatSummary(s) {
  const pct = (k) => (s.n ? `${((100 * k) / s.n).toFixed(1)}%` : "n/a");
  const lines = [
    `target ${s.shell}: ${s.n} unique commands; ${s.withSignal} (${pct(s.withSignal)}) carry a signal for another shell, ${s.certain} (${pct(s.certain)}) a certain one`,
  ];
  for (const [cls, k] of Object.entries(s.byClass).sort((a, b) => b[1] - a[1]))
    lines.push(
      `  ${cls.padEnd(15)} ${String(k).padStart(5)}  ${CLASSES[cls]?.slice(0, 70) ?? ""}`,
    );
  return lines.join("\n");
}
