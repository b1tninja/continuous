import type { ModelDescription, Tool } from "core";
import { estimateTokens } from "core/llm/promptSegments";
import { charsOver4, serializeMeasured } from "core/tools/toolOverhead";

/**
 * What a request carries before the conversation starts, against the room the
 * model has for input. Sizes are estimates at four characters per token, the
 * repo's proxy (core/llm/promptSegments.ts).
 */
export interface SetupCost {
  /** Tool definitions plus the system message, rules included. */
  setupTokens: number;
  window: number;
  /** Tokens kept for the reply (`maxTokens`); 0 when none is set. */
  replyTokens: number;
  /** What is left for the conversation, never below 0. */
  leftTokens: number;
}

/**
 * The tool definitions and the system message of a request. A tool is sized
 * as the model receives it (name, description, parameters; the measure of
 * plans/tool-overhead.md), not as the whole `Tool` object the request
 * manifest hashes: that also holds what only the GUI reads, and comes to
 * about twice the size. A model that takes its tools as text has them in the
 * system message, and none here.
 */
export function setupTokensOf(request: {
  tools?: readonly Tool[];
  systemMessage?: string;
}): number {
  const tools = (request.tools ?? []).reduce(
    (n, t) =>
      n +
      charsOver4(
        serializeMeasured({
          name: t.function.name,
          description: t.function.description ?? "",
          parameters: t.function.parameters,
        }),
      ),
    0,
  );
  return tools + estimateTokens(request.systemMessage ?? "");
}

/**
 * The cost to report when the tools and the system message take more than
 * half of `contextLength - maxTokens`. Undefined below that, and while the
 * window is not known: an assumed window would make the numbers a guess.
 */
export function smallWindowCost(args: {
  setupTokens: number;
  model: Pick<
    ModelDescription,
    "contextLength" | "contextLengthSource" | "completionOptions"
  >;
}): SetupCost | undefined {
  const { setupTokens, model } = args;
  const window = model.contextLength;
  if (!window || window <= 0 || model.contextLengthSource === "unknown") {
    return undefined;
  }
  const replyTokens = Math.max(0, model.completionOptions?.maxTokens ?? 0);
  const room = window - replyTokens;
  if (setupTokens <= room / 2) return undefined;
  return {
    setupTokens,
    window,
    replyTokens,
    leftTokens: Math.max(0, room - setupTokens),
  };
}

const n = (tokens: number) => tokens.toLocaleString("en-US");
/** Estimates are shown to the nearest hundred, so they do not read as exact. */
const about = (tokens: number) => n(Math.round(tokens / 100) * 100);

/** The one line for the notice above the input. */
export function smallWindowLine(cost: SetupCost): string {
  const start = `Tools and instructions take about ${about(cost.setupTokens)} of this model's ${n(cost.window)} tokens`;
  const left =
    cost.leftTokens < 50
      ? "nothing is left for the conversation"
      : `about ${about(cost.leftTokens)} are left for the conversation`;
  return cost.replyTokens > 0
    ? `${start}. With ${n(cost.replyTokens)} kept for the reply, ${left}.`
    : `${start}, so ${left}.`;
}
