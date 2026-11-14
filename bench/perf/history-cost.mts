// What a long session costs per save and per request: HistoryManager.save,
// load, the stuck check and the whole-history token count, on synthetic
// CLI-shaped histories of several sizes.
//
//   cd extensions/cli && npx tsx ../../bench/perf/history-cost.mts --out <dir outside the repo> [--result-bytes 2000]
//
// The session files are written under --out (it becomes the global folder for
// this process), never under ~/.continuous. No model, no network.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { round, summarize } from "./src/stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = flag("--out");
if (!out || resolve(out) === repo || resolve(out).startsWith(repo + sep)) {
  console.error("Usage: history-cost.mts --out <dir outside the repository>");
  process.exit(2);
}
const RESULT_BYTES = Number(flag("--result-bytes") ?? 2000);
const globalDir = join(resolve(out), "history-global-dir");
mkdirSync(globalDir, { recursive: true });
// before core/util/paths.ts is imported: it reads these once
process.env.CONTINUOUS_GLOBAL_DIR = globalDir;
process.env.CONTINUE_GLOBAL_DIR = globalDir;

const load = (p: string) => import(pathToFileURL(join(repo, p)).href);
const { default: historyManager } = await load("core/util/history.ts");
const { stepsFromHistory } = await load("core/util/stuckHistory.ts");
const { detectStuck } = await load("core/util/stuckSignals.ts");
const { countChatHistoryTokens } = await load(
  "extensions/cli/src/util/tokenizer.ts",
);

// real source text for the tool results, so escaping and BPE work are realistic
const corpus = readFileSync(
  join(repo, "extensions/cli/src/session.ts"),
  "utf8",
);

/** user, then rounds of assistant (one tool call) and its tool result */
function synth(messages: number, withPromptLogs: boolean) {
  const history: any[] = [
    {
      message: {
        role: "user",
        content: "Refactor the parser and run the tests.",
      },
      contextItems: [],
    },
  ];
  let promptChars = 3000;
  for (let i = 0; history.length < messages; i++) {
    const id = `call_${i}`;
    const at = (i * 977) % Math.max(1, corpus.length - RESULT_BYTES);
    const assistant: any = {
      message: {
        role: "assistant",
        content: `Reading file ${i} to check case ${i}.`,
        toolCalls: [
          {
            id,
            type: "function",
            function: {
              name: i % 5 === 0 ? "Bash" : "Read",
              arguments: JSON.stringify(
                i % 5 === 0
                  ? { command: `npm test -- src/f${i}.ts` }
                  : { filepath: `src/f${i}.ts` },
              ),
            },
          },
        ],
      },
      contextItems: [],
    };
    promptChars += RESULT_BYTES + 200;
    if (withPromptLogs) {
      // what the IDE keeps per request: the whole formatted prompt (PromptLog)
      assistant.promptLogs = [
        {
          modelTitle: "m",
          modelProvider: "p",
          prompt: corpus
            .repeat(Math.ceil(promptChars / corpus.length))
            .slice(0, promptChars),
          completion: "c".repeat(120),
        },
      ];
    }
    history.push(assistant);
    history.push({
      message: {
        role: "tool",
        content: corpus.slice(at, at + RESULT_BYTES),
        toolCallId: id,
      },
      contextItems: [],
    });
  }
  return history.slice(0, messages);
}

function time(fn: () => void, runs: number) {
  for (let i = 0; i < 2; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return summarize(samples);
}

const model = { name: "m", model: "gpt-4o", provider: "openai" } as any;
const cases: Array<[number, boolean]> = [
  [10, false],
  [100, false],
  [1000, false],
  [5000, false],
  [10, true],
  [100, true],
  [300, true],
];
for (const [n, logs] of cases) {
  const history = synth(n, logs);
  const session = {
    sessionId: `perf-${n}-${logs ? "logs" : "plain"}`,
    title: "perf",
    workspaceDirectory: "file:///c:/work/app",
    history,
  };
  const runs = n >= 1000 || logs ? 15 : 40;
  const save = time(() => historyManager.save(session as any), runs);
  const file = join(globalDir, "sessions", `${session.sessionId}.json`);
  const read = time(() => void JSON.parse(readFileSync(file, "utf8")), runs);
  const stuck = logs
    ? null
    : time(() => void detectStuck(stepsFromHistory(history)), runs);
  const tokens = logs
    ? null
    : time(() => void countChatHistoryTokens(history, model), runs);
  console.log(
    JSON.stringify({
      messages: n,
      promptLogs: logs,
      fileMB: round(statSync(file).size / 1e6, 2),
      compactMB: round(JSON.stringify(session).length / 1e6, 2),
      saveMedianMs: round(save.median, 2),
      saveP95Ms: round(save.p95, 2),
      loadMedianMs: round(read.median, 2),
      stuckMedianMs: stuck ? round(stuck.median, 3) : null,
      stuckP95Ms: stuck ? round(stuck.p95, 3) : null,
      tokenCountMedianMs: tokens ? round(tokens.median, 2) : null,
      tokenCountP95Ms: tokens ? round(tokens.p95, 2) : null,
    }),
  );
}
