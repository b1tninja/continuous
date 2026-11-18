import { RUN_STOP_EXIT_CODE } from "../budget/runBudget.js";
import { describePromptBlocked } from "../hooks/promptHook.js";
import { describeNetworkFailure } from "../util/networkError.js";

import type { RunErrorKind } from "./streamJsonEvents.js";

/**
 * The exit codes of a headless run (`continuous -p`), one table with
 * docs/cli/exit-codes.mdx; a test reads that page and compares. Codes that
 * existed before this table keep their numbers: 1, 2 (a broken hooks or
 * permissions file, and serve refusing to start), 3 (`continuous secrets`
 * found a secret), 20 to 22 (run limits) and 130 (Ctrl+C).
 */
export const HEADLESS_EXIT_CODES = {
  success: 0,
  error: 1,
  config: 2,
  secretsFound: 3,
  provider: 4,
  refused: 5,
  outputSchema: 6,
  budget: RUN_STOP_EXIT_CODE.budget,
  turns: RUN_STOP_EXIT_CODE.turns,
  duration: RUN_STOP_EXIT_CODE.duration,
  interrupted: 130,
} as const;

/** An error that names the exit code it ends a headless run with. */
export class HeadlessRunError extends Error {
  constructor(
    message: string,
    readonly kind: Exclude<RunErrorKind, "internal">,
  ) {
    super(message);
    this.name = "HeadlessRunError";
  }
}

/** The configuration cannot give the run a usable model, or a flag's file is unusable. */
export function configError(message: string): HeadlessRunError {
  return new HeadlessRunError(message, "config");
}

/** Messages of the config loader and model service that mean the config is unusable. */
const CONFIG_MESSAGES = [
  /^Failed to load config/,
  /^Unknown config source type/,
  /^Invalid saved config URI/,
  /hub assistants are not supported/i,
  /^Failed to initialize LLM/,
  /^Loaded default model contained no model block/,
  /^No models were found/,
  /^No LLM API instance found/,
];

/** A provider's HTTP status or message: the model call failed, not the CLI. */
const PROVIDER_MESSAGES =
  /\b(?:status(?: code)?:? ?[45]\d\d|HTTP [45]\d\d|[45]\d\d (?:Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable)|rate.?limit|overloaded|Context length exceeded|invalid x-api-key|authentication_error|invalid_api_key|ThrottlingException|AccessDeniedException|ValidationException)\b/i;

function httpStatusOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
    const e = current as Record<string, unknown>;
    for (const key of ["status", "statusCode"]) {
      const v = e[key];
      if (typeof v === "number" && v >= 400 && v < 600) return v;
    }
    const meta = e.$metadata as { httpStatusCode?: unknown } | undefined;
    if (
      typeof meta?.httpStatusCode === "number" &&
      meta.httpStatusCode >= 400
    ) {
      return meta.httpStatusCode;
    }
    current = e.cause;
  }
  return undefined;
}

const PROMPT_BLOCKED = describePromptBlocked("").trim();

export interface HeadlessFailure {
  kind: RunErrorKind;
  exitCode: number;
  message: string;
  /** A stable code, when there is one */
  code?: string;
}

const EXIT_OF_KIND: Record<RunErrorKind, number> = {
  config: HEADLESS_EXIT_CODES.config,
  provider: HEADLESS_EXIT_CODES.provider,
  refused: HEADLESS_EXIT_CODES.refused,
  output_schema: HEADLESS_EXIT_CODES.outputSchema,
  internal: HEADLESS_EXIT_CODES.error,
};

/** What a headless run that threw ended with, and its exit code. */
export function classifyHeadlessFailure(error: unknown): HeadlessFailure {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message || String(error);
  const of = (kind: RunErrorKind, code?: string): HeadlessFailure => ({
    kind,
    exitCode: EXIT_OF_KIND[kind],
    message,
    ...(code ? { code } : {}),
  });
  if (err instanceof HeadlessRunError) return of(err.kind);
  if (message.startsWith(PROMPT_BLOCKED))
    return of("refused", "prompt_blocked");
  if (CONFIG_MESSAGES.some((re) => re.test(message))) return of("config");
  const network = describeNetworkFailure(err);
  if (network) {
    return { ...of("provider", network.code), message: network.message };
  }
  const status = httpStatusOf(err);
  if (status !== undefined) return of("provider", `http_${status}`);
  if (PROVIDER_MESSAGES.test(message)) return of("provider");
  return of("internal");
}
