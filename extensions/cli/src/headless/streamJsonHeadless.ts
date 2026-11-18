import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";

import { RUN_STOP_EXIT_CODE, type RunStop } from "../budget/runBudget.js";
import * as runLimits from "../budget/runLimits.js";
import { stripThinkTags } from "../commands/chatOutput.js";
import { safeStderr, safeStdout } from "../init.js";
import { services } from "../services/index.js";
import { effortOfModel, onModelInUse } from "../services/modelInUse.js";
import { getSessionUsage } from "../session.js";
import { refusalCapReached } from "../stream/refusalCap.js";
import type { StreamChatResponseOptions } from "../stream/streamChatResponse.js";
import type { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import { hadUnhandledError } from "../util/errorState.js";
import { getVersion } from "../version.js";

import { classifyHeadlessFailure, HEADLESS_EXIT_CODES } from "./exitCodes.js";
import {
  loadOutputSchema,
  outputSchemaProblem,
  type OutputSchema,
} from "./outputSchema.js";
import {
  isStreamJson,
  type RunErrorKind,
  type RunStatus,
} from "./streamJsonEvents.js";
import {
  activeStreamJson,
  setActiveStreamJson,
  StreamJsonRun,
} from "./streamJsonRun.js";

export { isStreamJson, type HeadlessFormat } from "./streamJsonEvents.js";
export { configError } from "./exitCodes.js";

function sessionUsage() {
  try {
    return getSessionUsage();
  } catch {
    return undefined;
  }
}

/**
 * The run's stream, made once. Two handlers make sure a `result` line ends
 * the stream however the process leaves: Ctrl+C (the process handler exits
 * with 130 after its cleanup, so the line is written here, before that), and
 * any exit that did not write one.
 */
function ensureRun(): StreamJsonRun {
  const existing = activeStreamJson();
  if (existing) return existing;
  const run = new StreamJsonRun({ write: safeStdout, usage: sessionUsage });
  setActiveStreamJson(run);
  process.once("SIGINT", () => {
    run.finish({ status: "interrupted", exitCode: 130 });
  });
  process.once("exit", (code) => {
    run.finish({
      status: code === 0 ? "success" : code === 130 ? "interrupted" : "error",
      exitCode: code,
    });
  });
  return run;
}

let outputSchema: OutputSchema | undefined;
/** `--include-reasoning`: write each reply's reasoning as a `reasoning` line. */
let includeReasoning = false;

/**
 * Call at the start of a headless run: with `--format stream-json` the
 * stream exists from here on, so a failure after this still ends in a
 * `result` line. Reads `--output-schema` before any model request; a bad
 * file throws a config error.
 */
export function beginHeadlessRun(options: {
  format?: string;
  outputSchema?: string;
  includeReasoning?: boolean;
}): void {
  if (isStreamJson(options.format)) ensureRun();
  includeReasoning = options.includeReasoning === true;
  outputSchema = options.outputSchema
    ? loadOutputSchema(options.outputSchema)
    : undefined;
}

interface HistorySource {
  on(event: "stateChanged", listener: (state: unknown) => void): unknown;
  getHistory(): ChatHistoryItem[];
}

/**
 * Starts the stream of a `--format stream-json` run: writes `init` and
 * follows the conversation for tool calls and their results.
 */
export function startStreamJson(
  format: string | undefined,
  facts: {
    sessionId: string;
    model: string;
    provider: string;
    mode: string;
    reasoningEffort?: string;
    limits?: {
      maxBudgetUsd?: number;
      maxTurns?: number;
      maxDurationMinutes?: number;
    };
  },
  history: HistorySource,
): void {
  if (!isStreamJson(format)) return;
  const run = ensureRun();
  run.init(
    {
      sessionId: facts.sessionId,
      cliVersion: getVersion(),
      model: facts.model,
      provider: facts.provider,
      cwd: process.cwd(),
      mode: facts.mode,
      ...(facts.reasoningEffort
        ? { reasoningEffort: facts.reasoningEffort }
        : {}),
      ...(facts.limits && Object.keys(facts.limits).length > 0
        ? { limits: facts.limits }
        : {}),
    },
    history.getHistory(),
  );
  history.on("stateChanged", () => {
    try {
      run.observeHistory(history.getHistory());
    } catch {
      // the stream never breaks the run
    }
  });
  // A later switch of model or effort (a mode's or Loop turn's modeModels
  // entry, an item's own model, a subagent's): a `model` line (M7)
  stopFollowingModel?.();
  stopFollowingModel = onModelInUse((info) => run.modelInUse(info));
}

let stopFollowingModel: (() => void) | undefined;

/** `startStreamJson` for a headless run, with the facts read from the services. */
export function startStreamJsonRun(
  format: string | undefined,
  model: Pick<ModelConfig, "model" | "provider" | "requestOptions">,
): void {
  if (!isStreamJson(format)) return;
  startStreamJson(
    format,
    {
      sessionId: services.chatHistory.getSessionId(),
      model: model.model,
      provider: model.provider,
      mode: services.toolPermissions.getCurrentMode(),
      reasoningEffort: effortOfModel(model),
      limits: runLimits.activeRunBudget()?.limits,
    },
    services.chatHistory,
  );
}

/** The run's final answer, for `--output-schema` and the stream's `result` line. */
let finalAnswer = "";

/**
 * Keeps the final answer. Returns true with `--format stream-json`: the
 * answer then goes in the `result` line and nothing but events is printed.
 */
export function noteHeadlessAnswer(
  answer: string,
  silent: boolean | undefined,
  format: string | undefined,
): boolean {
  finalAnswer = silent ? stripThinkTags(answer) : answer;
  return isStreamJson(format);
}

/** The problem that makes a finished run fail: the refusal cap, or an answer that does not match the schema. */
function finishedRunProblem():
  | { kind: "refused" | "output_schema"; message: string; exitCode: number }
  | undefined {
  if (refusalCapReached()) {
    return {
      kind: "refused",
      message:
        "The run ended because tool calls kept being refused (the refusal cap).",
      exitCode: HEADLESS_EXIT_CODES.refused,
    };
  }
  const problem =
    outputSchema && outputSchemaProblem(outputSchema, finalAnswer);
  if (problem) {
    return {
      kind: "output_schema",
      message: problem,
      exitCode: HEADLESS_EXIT_CODES.outputSchema,
    };
  }
  return undefined;
}

/**
 * The exit code of a headless run that reached its end: a run limit's code,
 * else 1 when an unhandled error happened on the way (as gracefulExit
 * decides), else 0. With stream-json the `run_limit` and `result` lines.
 */
export function endHeadlessRun(format: string | undefined): number {
  const limitCode = runLimits.exitCodeOfRun(format);
  const stop = runLimits.currentRunStop();
  if (stop) {
    streamJsonRunLimit(stop);
    finishStreamJson({
      status: "stopped",
      exitCode: limitCode,
      result: finalAnswer,
    });
    return limitCode;
  }
  const problem = finishedRunProblem();
  if (problem) {
    if (isStreamJson(format)) {
      activeStreamJson()?.error(problem.kind, problem.message);
    } else {
      safeStderr(
        format === "json"
          ? JSON.stringify({
              status: "error",
              kind: problem.kind,
              message: problem.message,
              exitCode: problem.exitCode,
            }) + "\n"
          : `${problem.message} (exit ${problem.exitCode})\n`,
      );
    }
    finishStreamJson({
      status: problem.kind === "refused" ? "refused" : "error",
      exitCode: problem.exitCode,
      result: finalAnswer,
    });
    return problem.exitCode;
  }
  const exitCode = hadUnhandledError() ? HEADLESS_EXIT_CODES.error : 0;
  finishStreamJson({
    status: exitCode === 0 ? "success" : "error",
    exitCode,
    result: finalAnswer,
  });
  return exitCode;
}

/** The exit code of a run that failed with `error`; with stream-json its `error` and `result` lines. */
export function failHeadlessRun(
  options: { headless?: boolean; format?: string },
  error: Error,
): number {
  if (!options.headless) return HEADLESS_EXIT_CODES.error;
  const failure = classifyHeadlessFailure(error);
  failStreamJson(options.format, failure);
  return failure.exitCode;
}

/** What the model loop is given so the stream hears each reply and each finished request. */
export function streamJsonHooks(): {
  callbacks?: StreamCallbacks;
  options?: StreamChatResponseOptions;
} {
  const run = activeStreamJson();
  if (!run) return {};
  return {
    callbacks: {
      onContentComplete: (content) => run.message(content),
      ...(includeReasoning && {
        onReasoningComplete: (reasoning) =>
          run.reasoning(reasoning.text, reasoning.endAt - reasoning.startAt),
      }),
    },
    options: { onRequest: () => run.requestDone() },
  };
}

/** A run limit ended the run: the `run_limit` line, before `result`. */
export function streamJsonRunLimit(stop: RunStop | undefined): void {
  if (!stop) return;
  activeStreamJson()?.runLimit({
    reason: stop.reason,
    phase: stop.phase,
    detail: stop.detail,
    spentUsd: stop.spentUsd,
    exitCode: RUN_STOP_EXIT_CODE[stop.reason],
  });
}

/** The last line of a run that reached its end. */
export function finishStreamJson(end: {
  status: RunStatus;
  exitCode: number;
  result?: string;
}): void {
  activeStreamJson()?.finish(end);
}

/** A failed run: `error`, then `result`. Makes the stream if the run failed before `init`. */
export function failStreamJson(
  format: string | undefined,
  failure: {
    kind: RunErrorKind;
    message: string;
    code?: string;
    exitCode: number;
  },
): void {
  if (!isStreamJson(format)) return;
  const run = ensureRun();
  run.error(failure.kind, failure.message, failure.code);
  run.finish({
    status: failure.kind === "refused" ? "refused" : "error",
    exitCode: failure.exitCode,
  });
}
