import type { ModelDescription, Tool } from "core";
import {
  functionFingerprint,
  type HeldToolList,
  resolveToolList,
  toolChangeDropsThinking,
  toolChangeTiming,
  type ToolListDecision,
} from "core/tools/toolListHold";
import { selectActiveTools } from "../redux/selectors/selectActiveTools";
import { selectCacheSetting } from "../redux/selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import type { RootState } from "../redux/store";
import {
  type CacheLoss,
  isSignificantLoss,
  warmCacheLoss,
} from "./cacheSafeguards";
import type {
  PromptCacheSessionState,
  PromptCacheSetting,
} from "./promptCache";

/**
 * The GUI's side of core/tools/toolListHold.ts (C80, C88): while the prompt
 * cache is warm and re-reading it is significant, a change to the tool list
 * (a tool, a group or an MCP server turned on or off, a server that connects
 * late or changes its tools) waits, and requests keep offering the list the
 * last request offered.
 */

/**
 * What the tool list depends on besides the person's toggles. A change to any
 * of these is a rebuild the person chose (a mode or model switch warns on its
 * own), so whatever waited applies with it.
 */
export function toolListKey(state: RootState): string {
  const model = selectSelectedChatModel(state);
  return JSON.stringify([
    state.session.mode,
    model ? `${model.provider}/${model.model}/${model.title}` : "",
    state.session.loop?.current?.kind === "item",
    !!state.session.taskPlan?.items.length,
  ]);
}

export interface ToolListHoldInputs {
  /** The list the current settings give (selectActiveTools) */
  live: Tool[];
  sent?: HeldToolList<Tool>;
  key: string;
  model?: ModelDescription | null;
  setting?: PromptCacheSetting;
  cache?: PromptCacheSessionState;
  /** The person's setting: never wait */
  applyAtOnce?: boolean;
  /** The person chose Apply now */
  applyNext?: boolean;
  now: number;
}

export interface ToolListHoldStatus extends ToolListDecision<Tool> {
  /** What a change to the list re-reads now, when that is significant */
  loss?: CacheLoss;
  /** True when a change made now waits for the cache to go cold */
  waits: boolean;
  /**
   * Applying a change also drops the reasoning sent so far, whenever it
   * applies (preserved thinking's prefix check; see buildChatRequest)
   */
  dropsThinking: boolean;
}

export function toolListHoldStatus(i: ToolListHoldInputs): ToolListHoldStatus {
  const warm =
    i.model && i.cache
      ? warmCacheLoss(i.model, i.setting, i.cache, i.now)
      : undefined;
  const loss = warm && isSignificantLoss(warm) ? warm : undefined;
  const waits =
    !i.applyNext &&
    toolChangeTiming({
      warm: !!warm,
      significant: !!loss,
      applyAtOnce: i.applyAtOnce,
    }) === "queue";
  const decision = resolveToolList({
    live: i.live,
    held: i.sent,
    key: i.key,
    hold: waits,
    nameOf: (t) => t.function.name,
    fingerprintOf: functionFingerprint,
  });
  return {
    ...decision,
    loss,
    waits,
    dropsThinking: toolChangeDropsThinking(i.model?.model),
  };
}

export function toolListHoldInputs(
  state: RootState,
  now: number,
): ToolListHoldInputs {
  return {
    live: selectActiveTools(state),
    sent: state.session.sentToolList,
    key: toolListKey(state),
    model: selectSelectedChatModel(state),
    setting: selectCacheSetting(state),
    cache: state.session.promptCache,
    applyAtOnce: state.ui.applyToolChangesAtOnce,
    applyNext: state.session.applyToolChangesNext,
    now,
  };
}

/** The tool list a request built from `state` at `now` offers. */
export function heldToolList(
  state: RootState,
  now: number = Date.now(),
): ToolListHoldStatus {
  return toolListHoldStatus(toolListHoldInputs(state, now));
}

/**
 * The withheld tools: offered by the held list but not by the current
 * settings. `gone` is a tool no server offers any more (its server
 * disconnected or dropped it), rather than one turned off.
 */
export function withheldTools(
  status: ToolListDecision<Tool>,
  configTools: Tool[],
): { name: string; gone: boolean }[] {
  if (!status.held) return [];
  return status.pending.removed.map((name) => ({
    name,
    gone: !configTools.some((t) => t.function.name === name),
  }));
}
