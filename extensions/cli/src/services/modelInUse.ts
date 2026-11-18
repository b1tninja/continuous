import { EventEmitter } from "events";

import type { ModelConfig } from "@continuedev/config-yaml";

/**
 * The model and reasoning effort a turn actually goes to, and why (ROADMAP
 * M7). The model service records it on every switch, the status line shows
 * it, the TUI writes a line in the transcript when it changes, and
 * `-p --format stream-json` writes a `model` event. A subagent's model is
 * announced the same way, with its `agent`.
 */
export type ModelInUseReason =
  /** Chosen at start: the agent file's model, the persisted pick, or the config's first chat model */
  | "start"
  /** A use's `modeModels` entry (a mode switch, a Loop item or re-plan) */
  | "use"
  /** A Loop item's own model (`model:` under its to-do) */
  | "item"
  /** Picked by hand (`/model`) */
  | "manual"
  /** Back to the model an item's own model switched away from */
  | "restore"
  /** A subagent's own model */
  | "subagent";

export interface ModelInUse {
  /** The model's `name` in the config (its `model` when it has none) */
  name: string;
  /** The API model id */
  model: string;
  provider: string;
  /** The `reasoning_effort` the requests carry; absent when they carry none */
  effort?: string;
  reason: ModelInUseReason;
  /** The use whose turn this is, for `use` and `item` */
  use?: string;
  /** At start: where the choice came from */
  source?: "agentFile" | "persisted" | "default";
  /** Set when what was asked for is not what runs, and why */
  fallbackReason?: string;
  /** For a subagent: its name */
  agent?: string;
}

/** The `reasoning_effort` a model's requests carry (a use's effort or a catalog variant's). */
export function effortOfModel(
  model: Pick<ModelConfig, "requestOptions"> | null | undefined,
): string | undefined {
  const effort = (
    model?.requestOptions?.extraBodyProperties as
      Record<string, unknown> | undefined
  )?.reasoning_effort;
  return typeof effort === "string" && effort ? effort : undefined;
}

/** What a configured model is, in use for `reason`. */
export function modelInUseOf(
  model: ModelConfig,
  reason: ModelInUseReason,
  extra: Omit<
    ModelInUse,
    "name" | "model" | "provider" | "effort" | "reason"
  > = {},
): ModelInUse {
  const effort = effortOfModel(model);
  return {
    name: String((model as { name?: string }).name || model.model),
    model: String(model.model ?? ""),
    provider: model.provider,
    ...(effort ? { effort } : {}),
    reason,
    ...extra,
  };
}

/** `<name> (<effort>)`, or the name alone when the requests carry no effort. */
export function modelInUseLabel(info: Pick<ModelInUse, "name" | "effort">) {
  return info.effort ? `${info.name} (${info.effort})` : info.name;
}

/** True when two records name the same model at the same effort. */
export function sameModelInUse(
  a: ModelInUse | undefined,
  b: ModelInUse | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.provider === b.provider &&
    a.name === b.name &&
    a.model === b.model &&
    a.effort === b.effort
  );
}

const USE_NAMES: Record<string, string> = {
  plan: "Plan",
  agent: "Agent",
  chat: "Chat",
  loop: "Loop item",
  replan: "Re-plan",
  subagent: "Subagent",
  reviewer: "Reviewer",
};

/** The transcript line: `Model: <name> (<effort>), <why>`. */
export function describeModelInUse(info: ModelInUse): string {
  const label = modelInUseLabel(info);
  const use = info.use ? (USE_NAMES[info.use] ?? info.use) : undefined;
  let why: string;
  switch (info.reason) {
    case "use":
      why = use ? `for ${use} (modeModels)` : "from modeModels";
      break;
    case "item":
      why = "the Loop item's own model";
      break;
    case "manual":
      why = "picked with /model";
      break;
    case "restore":
      why = "back from a Loop item's own model";
      break;
    case "subagent":
      why = info.agent ? `subagent ${info.agent}` : "subagent";
      break;
    default:
      why = "at start";
  }
  const fallback = info.fallbackReason ? `; ${info.fallbackReason}` : "";
  return `Model: ${label}, ${why}${fallback}`;
}

const events = new EventEmitter();

/** Tell the surfaces (TUI transcript, stream-json) that the model in use changed. */
export function announceModelInUse(info: ModelInUse): void {
  try {
    events.emit("change", info);
  } catch {
    // a listener's failure must not change a run
  }
}

/** Follow model changes; returns the unsubscribe. */
export function onModelInUse(listener: (info: ModelInUse) => void): () => void {
  events.on("change", listener);
  return () => {
    events.off("change", listener);
  };
}

/**
 * Which changes get a transcript line: one per change of model or effort,
 * not one per turn. A `/model` pick prints its own line, and a subagent's
 * model goes in its own output, so neither adds one here.
 */
export class ModelNoteGate {
  private shown: ModelInUse | undefined;

  constructor(initial?: ModelInUse) {
    this.shown = initial;
  }

  /** The line to write for `info`, or undefined when there is nothing new. */
  next(info: ModelInUse): string | undefined {
    if (info.reason === "subagent") return undefined;
    const changed = !sameModelInUse(this.shown, info);
    this.shown = info;
    if (!changed || info.reason === "manual") return undefined;
    return describeModelInUse(info);
  }
}
