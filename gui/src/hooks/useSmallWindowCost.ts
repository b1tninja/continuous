import { promptProfile } from "core/llm/prompts/turns";
import { promptChoiceFor } from "core/llm/prompts/usePrompts";
import { renderChatMessage } from "core/util/messageContent";
import { useMemo } from "react";
import { useStore } from "react-redux";
import { useAppSelector } from "../redux/hooks";
import { selectActiveTools } from "../redux/selectors/selectActiveTools";
import { selectModelUse } from "../redux/selectors/selectModelUse";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import type { RootState } from "../redux/store";
import { buildChatRequest } from "../redux/util/buildChatRequest";
import {
  type SetupCost,
  setupTokensOf,
  smallWindowCost,
} from "../util/smallWindow";

/** The mode whose turn text is the full one and could be the short one. */
export function shortPromptModeOf(
  state: RootState,
): "agent" | "plan" | undefined {
  const mode = state.session.mode;
  const model = selectSelectedChatModel(state);
  if (!model || (mode !== "agent" && mode !== "plan")) return undefined;
  // A Loop item or re-plan may have a prompt of its own
  if (selectModelUse(state) !== mode) return undefined;
  // The model's own text replaces the turn text, so a profile changes nothing
  const own =
    mode === "agent"
      ? model.baseAgentSystemMessage
      : model.basePlanSystemMessage;
  if (own) return undefined;
  const choice = promptChoiceFor(state.config.config.modeModels, mode);
  if (choice?.text !== undefined) return undefined;
  const profile = choice?.profile ?? promptProfile(model.model);
  return profile === "full" ? mode : undefined;
}

/**
 * What the tools and the system message of the current mode cost on the
 * selected model, when that is more than half of its room for input
 * (util/smallWindow.ts). Sized from the request the session would send with
 * an empty conversation, built by the builder every chat request uses.
 *
 * Building that request costs milliseconds, so it is done when the model, the
 * mode, the tool list or the config changes, and never per streamed batch:
 * nothing selected here changes while a reply streams.
 */
export function useSmallWindowCost(
  opts: { enabled?: boolean } = {},
):
  | { cost: SetupCost; shortPromptMode: "agent" | "plan" | undefined }
  | undefined {
  const enabled = opts.enabled ?? true;
  const store = useStore<RootState>();
  const model = useAppSelector(selectSelectedChatModel);
  const mode = useAppSelector((s) => s.session.mode);
  const tools = useAppSelector(selectActiveTools);
  // While the prompt cache is warm a request keeps the list the last one sent
  const sentTools = useAppSelector((s) => s.session.sentToolList);
  const config = useAppSelector((s) => s.config.config);
  const ruleSettings = useAppSelector((s) => s.ui.ruleSettings);

  return useMemo(() => {
    if (!enabled || !model) return undefined;
    // An unknown window needs no request built to say nothing
    if (!smallWindowCost({ setupTokens: Infinity, model })) return undefined;
    const state = store.getState();
    let setupTokens: number;
    try {
      const request = buildChatRequest(state, []);
      const system = request.messages[0];
      setupTokens = setupTokensOf({
        tools: request.completionOptions.tools,
        systemMessage:
          system?.role === "system" ? renderChatMessage(system) : undefined,
      });
    } catch {
      return undefined;
    }
    const cost = smallWindowCost({ setupTokens, model });
    return cost && { cost, shortPromptMode: shortPromptModeOf(state) };
    // The selections above are what the request's tools and system message read
  }, [store, enabled, model, mode, tools, sentTools, config, ruleSettings]);
}
