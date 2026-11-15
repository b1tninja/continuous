import type { LLMFullCompletionOptions, ModelDescription, Tool } from "core";
import type { ChatMessage, RuleMetadata } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import {
  promptChoiceFor,
  tailFor,
  withTurnTail,
} from "core/llm/prompts/usePrompts";
import { rulesEnabledForUse } from "core/llm/rules/rulesByMode";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { BuiltInToolNames } from "core/tools/builtIn";
import { loopRunPlanBlock, withLoopPlanBlock } from "core/util/loopMode";
import { taskPlanTailMessage } from "core/util/taskPlan";
import {
  getModeReasoningEffort,
  reasoningOptionsForEffort,
} from "../../util/modeModels";
import {
  functionFingerprint,
  sameToolList,
  thinkingCutAfterToolChange,
} from "core/tools/toolListHold";
import {
  heldToolList,
  toolListKey,
  type ToolListHoldStatus,
} from "../../util/toolListHold";
import { applyToolSearch } from "./applyToolSearch";
import { selectModelUse } from "../selectors/selectModelUse";
import { selectSelectedChatModel } from "../slices/configSlice";
import type { RootState } from "../store";
import { constructMessages } from "./constructMessages";
import { getBaseSystemMessage } from "./getBaseSystemMessage";

/** The plan block of the running item's run, kept between its requests. */
const runPlanMemo: { key?: string; block?: string } = {};

/**
 * Builds completion options with reasoning configuration based on session state and model capabilities.
 *
 * @param baseOptions - Base completion options to extend
 * @param hasReasoningEnabled - Whether reasoning is enabled in the session
 * @param model - The selected model with provider and completion options
 * @returns Completion options with reasoning configuration
 */
export function buildReasoningCompletionOptions(
  baseOptions: LLMFullCompletionOptions,
  hasReasoningEnabled: boolean | undefined,
  model: ModelDescription,
): LLMFullCompletionOptions {
  if (hasReasoningEnabled === undefined) {
    return baseOptions;
  }

  const reasoningOptions: LLMFullCompletionOptions = {
    ...baseOptions,
    reasoning: !!hasReasoningEnabled,
  };

  // Add reasoning budget tokens if reasoning is enabled and provider supports it
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    // Ollama doesn't support limiting reasoning tokens at this point
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }

  return reasoningOptions;
}

export interface ChatRequest {
  model: ModelDescription;
  activeTools: Tool[];
  /** Tools, reasoning and nothing else: the caller adds the cache options. */
  completionOptions: LLMFullCompletionOptions;
  /** The final system message first, then the conversation. */
  messages: ChatMessage[];
  /**
   * The session's task list as a message to send after `messages`, when the
   * task list tool is offered. Kept apart so that the cache-miss key and the
   * compaction request see only the conversation: the list changes at the
   * tail of every request and must not count as an edit to it.
   */
  taskListMessage: ChatMessage | undefined;
  appliedRules: RuleMetadata[];
  appliedRuleIndex: number;
  /** Set when the model takes tools as text in the system message. */
  systemToolsFramework: SystemMessageToolCodeblocksFramework | undefined;
  /**
   * The tool list before model overrides and tool search, with its context
   * key: what the request records as sent (setSentToolList). `held` is true
   * when a change to the list is waiting for the prompt cache to go cold;
   * `pending.removed` are then withheld tools, refused if called (C88).
   */
  toolList: ToolListHoldStatus & { key: string };
  /**
   * On a model whose preserved thinking breaks when `tools[]` changes, the
   * history index before which reasoning is not sent: set by the request
   * that changes the list, kept for the later ones (thinkingCutAt).
   */
  thinkingCut: number | undefined;
}

/**
 * Everything about a chat request that comes from the session and config: the
 * tools, the reasoning options, the system message (base message, matched
 * rules, any summary) and the messages. Pure: it dispatches nothing. Used for
 * the chat request and for the compaction request that has to start with the
 * same bytes, so the two cannot drift apart.
 *
 * `history` defaults to the whole session; a shorter one builds the request as
 * it would have been after that many items.
 *
 * Loop mode runs each item and re-plan in a fresh context (LoopState
 * freshContext): the request carries only the turns since that run started,
 * while the chat still shows everything.
 */
export function buildChatRequest(
  state: RootState,
  history = state.session.history,
  /** For the prompt cache's age: whether a tool change still waits (C80) */
  now: number = Date.now(),
): ChatRequest {
  const model = selectSelectedChatModel(state);
  if (!model) {
    throw new Error("No chat model selected");
  }

  // The tools the settings give, or while the prompt cache is warm the list
  // the last request offered (core/tools/toolListHold.ts), then the
  // model-level overrides (disabled, description, etc.)
  const toolList = { ...heldToolList(state, now), key: toolListKey(state) };
  let activeTools = toolList.tools;
  // A changed tool list invalidates the reasoning minted under the old one on
  // models with preserved thinking's prefix check, and sending it back is a
  // 400 (plans/research/mid-session-tool-changes.md 6.5): from this request
  // on, the reasoning before the change is left out
  const sent = state.session.sentToolList;
  const thinkingCut = thinkingCutAfterToolChange({
    modelId: model.model,
    listChanged:
      !!sent &&
      sent.key === toolList.key &&
      !sameToolList(sent.tools, toolList.tools, functionFingerprint),
    historyLength: history.length,
    previous: state.session.thinkingCutAt,
  });
  if (model.toolOverrides?.length) {
    const { tools: overriddenTools, errors } = applyToolOverrides(
      activeTools,
      model.toolOverrides,
    );
    activeTools = overriddenTools;
    for (const error of errors) {
      if (!error.fatal) {
        console.warn(`Tool override warning: ${error.message}`);
      }
    }
  }

  // experimental.toolSearch: "auto" defers MCP tools above a token budget
  activeTools = applyToolSearch(activeTools, {
    setting: state.config.config.experimental?.toolSearch,
    mode: state.session.mode,
    family: model.model,
    history,
  });

  // Use the centralized selector to determine if system message tools should be used
  const useNativeTools = state.config.config.experimental
    ?.onlyUseSystemMessageTools
    ? false
    : modelSupportsNativeTools(model);
  const systemToolsFramework = !useNativeTools
    ? new SystemMessageToolCodeblocksFramework()
    : undefined;

  // Construct completion options
  let completionOptions: LLMFullCompletionOptions = {};
  if (useNativeTools && activeTools.length > 0) {
    completionOptions = {
      tools: activeTools,
    };
  }

  // An explicit reasoning toggle wins; otherwise use the configured reasoning
  // effort for what this request is (`modeModels.<use>.reasoningEffort`: the
  // mode, or a Loop item or re-plan).
  const use = selectModelUse(state);
  const modeReasoning =
    state.session.hasReasoningEnabled === undefined && use
      ? reasoningOptionsForEffort(
          getModeReasoningEffort(state.config.config, use),
        )
      : undefined;
  completionOptions = modeReasoning
    ? { ...completionOptions, ...modeReasoning }
    : buildReasoningCompletionOptions(
        completionOptions,
        state.session.hasReasoningEnabled,
        model,
      );

  // Construct messages (excluding system message). The use's prompt choice
  // (`modeModels.<use>.prompt`) picks the turn text: a Loop item may run on
  // the short text while Agent mode keeps the full one.
  const baseSystemMessage = getBaseSystemMessage(
    state.session.mode,
    model,
    activeTools,
    use ? promptChoiceFor(state.config.config.modeModels, use) : undefined,
  );

  const systemMessage = systemToolsFramework
    ? addSystemMessageToolsToSystemMessage(
        systemToolsFramework,
        baseSystemMessage,
        activeTools,
      )
    : baseSystemMessage;

  const loop = state.session.loop;
  const contextStart =
    history === state.session.history &&
    loop?.current &&
    loop.freshContext !== false
      ? Math.min(loop.current.historyIndex, history.length)
      : 0;

  // Loop mode: an item's run gets the plan block (its slots, the notes and
  // the person's standing instructions) after its prompt, fixed for the run,
  // while the task list tool is hidden from it. Every request of the run then
  // only extends the one before it, so a prompt cache keeps matching
  // (core's loopRunPlanBlock).
  const loopBlock =
    history === state.session.history &&
    loop?.current?.kind === "item" &&
    state.session.taskPlan
      ? loopRunPlanBlock(runPlanMemo, { loop, plan: state.session.taskPlan })
      : "";
  const promptIndex = loopBlock ? loop?.current?.historyIndex : undefined;

  const withoutMessageIds = history.slice(contextStart).map((item, i) => {
    const { id, ...messageWithoutId } = item.message as typeof item.message & {
      id?: string;
    };
    if (i + contextStart === promptIndex) {
      return {
        ...item,
        message: {
          ...messageWithoutId,
          content: withLoopPlanBlock(messageWithoutId.content, loopBlock),
        } as typeof messageWithoutId,
      };
    }
    return { ...item, message: messageWithoutId };
  });

  // The use's tail (`modeModels.<use>.tail`): a one-line reminder at the end
  // of every user message of the request, after the Loop plan block on the
  // item prompt. On every user message, not the newest only, so that each
  // request is an extension of the one before: the system message is the
  // same bytes with or without it, and a message's bytes never change once
  // sent (core/llm/prompts/usePrompts.ts). A per-use line in the system
  // message would break the whole conversation's cache instead. It goes on
  // the history's user messages before constructMessages, so the user-role
  // messages that carry tool output for a model without native tools get
  // none: the line is for the person's messages.
  const tail = use
    ? tailFor(state.config.config.modeModels, use, model.model)
    : undefined;
  // Each sent item's index in the history, for the applied rules below
  const sentIndex = withoutMessageIds
    .map((_, i) => i + contextStart)
    .filter(
      (at) =>
        thinkingCut === undefined ||
        history[at].message.role !== "thinking" ||
        at >= thinkingCut,
    );
  const sentItems =
    sentIndex.length === withoutMessageIds.length
      ? withoutMessageIds
      : sentIndex.map((at) => withoutMessageIds[at - contextStart]);
  const withTail = tail
    ? sentItems.map((item) =>
        item.message.role === "user"
          ? { ...item, message: withTurnTail([item.message], tail)[0] }
          : item,
      )
    : sentItems;

  const {
    messages,
    appliedRules,
    appliedRuleIndex: runRuleIndex,
  } = constructMessages(
    withTail as any,
    systemMessage,
    // The per-use global rules switch (rulesByMode): off for this use means
    // no rules are matched at all. A Loop item follows Agent, a re-plan Plan,
    // unless given a switch of its own.
    rulesEnabledForUse(state.config.config.rulesByMode, use)
      ? state.config.config.rules
      : [],
    state.ui.ruleSettings,
    systemToolsFramework,
  );

  const appliedRuleIndex =
    runRuleIndex >= 0
      ? (sentIndex[runRuleIndex] ?? runRuleIndex + contextStart)
      : runRuleIndex;

  const taskListMessage: ChatMessage | undefined = loopBlock
    ? undefined
    : activeTools.some((t) => t.function.name === BuiltInToolNames.TaskList)
      ? taskPlanTailMessage(state.session.taskPlan)
      : undefined;

  return {
    model,
    activeTools,
    completionOptions,
    messages,
    taskListMessage,
    appliedRules,
    appliedRuleIndex,
    systemToolsFramework,
    toolList,
    thinkingCut,
  };
}
