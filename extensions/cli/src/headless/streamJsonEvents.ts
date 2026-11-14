/**
 * The events of `-p --format stream-json`: one JSON object per line on
 * stdout, nothing else. The same contract is written down as a JSON Schema in
 * `spec/stream-json.schema.json`; a test keeps the two equal.
 *
 * Changing a field's meaning, removing a field or removing an event type
 * raises STREAM_JSON_SCHEMA_VERSION. Adding an optional field or a new event
 * type does not, so a reader must ignore what it does not know.
 */
export const STREAM_JSON_SCHEMA_VERSION = 1;

/** Every event type, in the order a run can first produce them. */
export const STREAM_JSON_EVENT_TYPES = [
  "init",
  "model",
  "reasoning",
  "message",
  "tool_use",
  "tool_decision",
  "tool_result",
  "usage",
  "run_limit",
  "error",
  "result",
] as const;

export type StreamJsonEventType = (typeof STREAM_JSON_EVENT_TYPES)[number];

/** The values `--format` takes with `-p`. */
export const HEADLESS_FORMATS = ["json", "stream-json"] as const;

export type HeadlessFormat = (typeof HEADLESS_FORMATS)[number];

export function isStreamJson(format: string | undefined): boolean {
  return format === "stream-json";
}

interface EventBase<T extends StreamJsonEventType> {
  type: T;
  /** Starts at 1 and goes up by one with every line of the run. */
  seq: number;
  /** When the event was written, ISO 8601 in UTC. */
  time: string;
}

/** The first line of every run. */
export interface InitEvent extends EventBase<"init"> {
  schemaVersion: typeof STREAM_JSON_SCHEMA_VERSION;
  sessionId: string;
  cliVersion: string;
  model: string;
  provider: string;
  cwd: string;
  /** The permission mode the run started in. */
  mode: string;
  /** The `reasoning_effort` the first requests carry; absent when none. */
  reasoningEffort?: string;
  /** The run limits in force; absent when none is set. */
  limits?: {
    maxBudgetUsd?: number;
    maxTurns?: number;
    maxDurationMinutes?: number;
  };
}

/**
 * The model or reasoning effort the next requests go to changed after
 * `init` (a mode's or a Loop turn's `modeModels` entry, a Loop item's own
 * model, a subagent starting on its own model). Written once per change.
 */
export interface ModelEvent extends EventBase<"model"> {
  /** The API model id. */
  model: string;
  provider: string;
  /** The model's `name` in the config. */
  name: string;
  /** The `reasoning_effort` the requests carry; absent when none. */
  reasoningEffort?: string;
  /** use: a `modeModels` entry; item: a Loop item's own model; manual: `/model`; restore: back from an item's model; subagent: a subagent's model. */
  reason: "use" | "item" | "manual" | "restore" | "subagent";
  /** The use whose requests these are: plan, agent, loop, replan, subagent. */
  use?: string;
  /** The subagent, for reason `subagent`. */
  agent?: string;
  /** Why the model asked for is not the one that runs. */
  fallbackReason?: string;
}

/**
 * One reply's reasoning (thinking), masked, whole, before the reply's
 * `message` and `tool_use` lines. Written only with `--include-reasoning`.
 * What a provider returns is often a summary of the model's thinking, not
 * all of it.
 */
export interface ReasoningEvent extends EventBase<"reasoning"> {
  role: "assistant";
  content: string;
  /** From the first reasoning to the start of the answer, when known. */
  durationMs?: number;
}

/** One complete reply of the model, masked. Never a partial chunk. */
export interface MessageEvent extends EventBase<"message"> {
  role: "assistant";
  content: string;
}

/** The model asked for a tool call. Nothing has been decided or run yet. */
export interface ToolUseEvent extends EventBase<"tool_use"> {
  callId: string;
  tool: string;
  /** The arguments, masked; a long string value is cut and ends in " [cut]". */
  args: Record<string, unknown>;
}

export type ToolDecision = "allowed" | "asked" | "refused";

/** What the permission system decided about a call, and who decided. */
export interface ToolDecisionEvent extends EventBase<"tool_decision"> {
  callId: string;
  tool: string;
  /**
   * `allowed`: the call runs. `refused`: it does not. `asked`: it was put to
   * a person (`answer` says what they said) or held as a question for one
   * (`held`), which in a headless run means it did not run.
   */
  decision: ToolDecision;
  /** Who decided: your rules, the reviewer model, the system or a person. */
  by: "rules" | "reviewer" | "system" | "person";
  /** Where the deciding rule lives, when one decided. */
  source?: string;
  /** The rule as written, masked. */
  rule?: string;
  /** Why, in the words the model is given, masked. */
  reason?: string;
  /** Set when a person answered: whether they approved. */
  answer?: "approved" | "denied";
  /** Set when the call is held as a question instead of being asked now. */
  held?: true;
}

/** A call reached its end: it ran, failed, or did not run. */
export interface ToolResultEvent extends EventBase<"tool_result"> {
  callId: string;
  tool: string;
  /** `done`: ran. `errored`: ran and failed, or was invalid. `canceled`: did not run. */
  status: "done" | "errored" | "canceled";
  /** The text the model is given, masked and cut to `outputChars` at most. */
  output: string;
  /** The length of the masked text before it was cut. */
  outputLength: number;
  truncated: boolean;
}

/**
 * Where a price came from and as of when: `user` (a price the person
 * entered), `provider` (a list the provider publishes, downloaded), `curated`
 * (a table in Continuous checked against the provider's pricing page),
 * `community` (the models.dev catalogue: a third-party estimate, the last
 * resort).
 */
export interface PriceSourceJson {
  kind: "user" | "provider" | "curated" | "community";
  label: string;
  url?: string;
  /** ISO date or date-time the prices were checked or downloaded. */
  asOf?: string;
}

/** One model request's tokens and price, after the provider reported them. */
export interface UsageEvent extends EventBase<"usage"> {
  /** 1 for the run's first model request. */
  request: number;
  /** Input the provider processed: uncached, cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** List price in US dollars; 0 for a model with no price. */
  costUsd: number;
  /** The run's spend so far, this request included. */
  totalCostUsd: number;
  /** True when a fallback rate priced part of the total. */
  costEstimated: boolean;
  /** Where this request's price came from; absent when it was not priced. */
  priceSource?: PriceSourceJson;
  /**
   * The non-standard service tier the provider reported serving (`flex`,
   * `priority`, ...); `costUsd` is then the standard-tier price.
   */
  servedTier?: string;
}

/** A run limit ended the run (see the run limits page). */
export interface RunLimitEvent extends EventBase<"run_limit"> {
  reason: "budget" | "turns" | "duration";
  phase: "before-call" | "after-call";
  message: string;
  exitCode: number;
  spentUsd?: number;
}

export type RunErrorKind =
  "config" | "refused" | "provider" | "output_schema" | "internal";

/** The run failed. A `result` line with the same exit code follows. */
export interface ErrorEvent extends EventBase<"error"> {
  kind: RunErrorKind;
  /** Masked. */
  message: string;
  /** A stable code when there is one, for example `network_unreachable`. */
  code?: string;
}

export type RunStatus =
  "success" | "error" | "refused" | "stopped" | "interrupted";

/** The last line of every run, whatever ended it. */
export interface ResultEvent extends EventBase<"result"> {
  schemaVersion: typeof STREAM_JSON_SCHEMA_VERSION;
  status: RunStatus;
  /** The process exit code that follows this line. */
  exitCode: number;
  /** The final answer, masked; empty when the run produced none. */
  result: string;
  durationMs: number;
  /** Model requests the run made. */
  numRequests: number;
  /** Tool calls the model asked for. */
  numToolCalls: number;
  /** Tool calls that were refused. */
  numRefusals: number;
  /** Tool calls IDGAF ran that a rule or guard would have refused or asked about. */
  numIdgafObjections: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  totalCostUsd: number;
  costEstimated: boolean;
  /** Where the prices of the run's priced requests came from, one per source. */
  priceSources?: PriceSourceJson[];
  /** Non-standard service tiers the providers reported serving in the run. */
  servedTiers?: string[];
}

export type StreamJsonEvent =
  | InitEvent
  | ModelEvent
  | ReasoningEvent
  | MessageEvent
  | ToolUseEvent
  | ToolDecisionEvent
  | ToolResultEvent
  | UsageEvent
  | RunLimitEvent
  | ErrorEvent
  | ResultEvent;

/** An event before the emitter numbers and dates it. */
export type StreamJsonEventBody = StreamJsonEvent extends infer E
  ? E extends StreamJsonEvent
    ? Omit<E, "seq" | "time">
    : never
  : never;
