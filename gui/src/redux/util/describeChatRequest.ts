import type { ChatMessage, RuleWithSource, Tool } from "core";
import {
  type Offender,
  type PromptSegment,
  canonicalTools,
  makeSegment,
} from "core/llm/promptSegments";
import { promptProfile } from "core/llm/prompts/turns";
import { promptChoiceFor, tailFor } from "core/llm/prompts/usePrompts";
import {
  getRuleId,
  isGlobalRule,
} from "core/llm/rules/getSystemMessageWithRules";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { generateToolsSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { renderChatMessage } from "core/util/messageContent";
import { selectModelUse } from "../selectors/selectModelUse";
import type { RootState } from "../store";
import { type ChatRequest, buildChatRequest } from "./buildChatRequest";
import { getBaseSystemMessage } from "./getBaseSystemMessage";
import { SUMMARY_MESSAGE_PREFIX } from "core/util/summaryMessage";

/**
 * Describes, without changing anything, the segments the IDE's chat request
 * carries (core/llm/promptSegments.ts). Built from the same inputs the request
 * builders use: the request comes from `buildChatRequest`, the base system
 * message from `getBaseSystemMessage` called as the builder calls it, the tool
 * block from `generateToolsSystemMessage`. Nothing here is sent.
 */

// A rule that is not global comes and goes with the files in play.
const isScoped = (r: RuleWithSource) => !isGlobalRule(r);

function toolSegments(request: ChatRequest, state: RootState): PromptSegment[] {
  const tools: Tool[] = request.completionOptions.tools ?? [];
  if (tools.length === 0) return [];
  const mode = state.session.mode;
  const builtin = tools.filter((t) => t.group === BUILT_IN_GROUP_NAME);
  const rest = tools.filter((t) => t.group !== BUILT_IN_GROUP_NAME);
  const events: Offender[] = ["mode-switch"];
  if (tools.some((t) => t.function.name === BuiltInToolNames.TaskList)) {
    events.push("tool-list-event");
  }
  if (state.session.loop?.current?.kind === "item") {
    events.push("tool-list-event");
  }
  if (tools.some((t) => t.function.name === "subagent")) {
    events.push("registry-in-tool-description");
  }
  const out: PromptSegment[] = [
    makeSegment({
      id: `tools.builtin@${mode}`,
      source: "builtin",
      stability: "static",
      region: "tools",
      text: canonicalTools(builtin),
      exposedTo: [...new Set(events)],
    }),
  ];
  if (rest.length > 0) {
    out.push(
      makeSegment({
        id: "tools.mcp",
        source: "mcp",
        stability: "session",
        region: "tools",
        text: canonicalTools(rest),
      }),
    );
  }
  return out;
}

function ruleSegments(request: ChatRequest, state: RootState, text: string) {
  const available = state.config.config.rules;
  const byId = new Map(available.map((r) => [getRuleId(r), r]));
  const out: PromptSegment[] = [];
  const applied = request.appliedRules
    .map((m) => byId.get(getRuleId(m)))
    .filter((r): r is RuleWithSource => !!r);
  if (!text.trim()) return out;
  for (const rule of applied) {
    const scoped = isScoped(rule);
    out.push(
      makeSegment({
        id: `rules.${scoped ? "scoped" : "session"}:${rule.name ?? getRuleId(rule)}`,
        source: "rules",
        stability: scoped ? "turn" : "session",
        region: "system",
        text: rule.rule,
        exposedTo: scoped ? ["scoped-rule-appended"] : undefined,
      }),
    );
  }
  return out;
}

function systemSegments(
  request: ChatRequest,
  state: RootState,
): PromptSegment[] {
  const system = request.messages[0];
  if (!system || system.role !== "system") return [];
  const full = renderChatMessage(system);
  const model = request.model;
  const mode = state.session.mode;
  const use = selectModelUse(state);
  const choice = use
    ? promptChoiceFor(state.config.config.modeModels, use)
    : undefined;
  const base = getBaseSystemMessage(mode, model, request.activeTools, choice);
  const custom =
    (mode === "agent" && model.baseAgentSystemMessage) ||
    (mode === "plan" && model.basePlanSystemMessage) ||
    (mode === "chat" && model.baseChatSystemMessage);
  const profile = custom
    ? "custom"
    : (choice?.profile ?? promptProfile(model.model));
  const out: PromptSegment[] = [];
  if (!full.startsWith(base)) {
    return [
      makeSegment({
        id: "system.unsplit",
        source: "mode",
        stability: "static",
        region: "system",
        text: full,
      }),
    ];
  }
  out.push(
    makeSegment({
      id: `turn.${mode}@${profile}`,
      source: "mode",
      stability: "static",
      region: "system",
      text: base,
      exposedTo: mode === "chat" ? undefined : ["mode-switch"],
    }),
  );
  let rest = full.slice(base.length);
  if (request.systemToolsFramework && request.activeTools.length > 0) {
    const block = `\n\n${generateToolsSystemMessage(
      request.activeTools,
      request.systemToolsFramework,
    )}`;
    if (rest.startsWith(block)) {
      out.push(
        makeSegment({
          id: `format.${mode}`,
          source: "format",
          stability: "static",
          region: "system",
          text: block,
          exposedTo: ["tool-list-event"],
        }),
      );
      rest = rest.slice(block.length);
    }
  }
  out.push(...ruleSegments(request, state, rest));
  return out;
}

/** The message that carries a compaction summary: the first after the system message. */
function summaryMessageOf(request: ChatRequest): ChatMessage | undefined {
  const first = request.messages.find((m) => m.role !== "system");
  return first?.role === "user" &&
    typeof first.content === "string" &&
    first.content.startsWith(SUMMARY_MESSAGE_PREFIX)
    ? first
    : undefined;
}

function conversationSegments(
  request: ChatRequest,
  state: RootState,
): PromptSegment[] {
  const summary = summaryMessageOf(request);
  const conversation: ChatMessage[] = request.messages.filter(
    (m) => m.role !== "system" && m !== summary,
  );
  const out: PromptSegment[] = [];
  // After a compaction the summary is the first user message (C104): it
  // changes only at the next compaction, and the system message before it
  // does not change at all
  if (summary) {
    out.push(
      makeSegment({
        id: "summary.compaction",
        source: "summary",
        stability: "session",
        region: "first-user",
        text: renderChatMessage(summary),
      }),
    );
  }
  out.push(
    makeSegment({
      id: "history",
      source: "history",
      stability: "turn",
      region: "history",
      text: JSON.stringify(conversation),
    }),
  );
  const use = selectModelUse(state);
  const tail = use
    ? tailFor(state.config.config.modeModels, use, request.model.model)
    : undefined;
  if (tail) {
    out.push(
      makeSegment({
        id: "tail.turn",
        source: "tail",
        stability: "turn",
        region: "tail",
        text: tail,
      }),
    );
  }
  if (request.taskListMessage) {
    out.push(
      makeSegment({
        id: "task-list",
        source: "task-list",
        stability: "request",
        region: "tail",
        text: renderChatMessage(request.taskListMessage),
      }),
    );
  }
  return out;
}

/** The manifest of the request `buildChatRequest(state, history)` builds. */
export function describeChatRequest(
  state: RootState,
  history = state.session.history,
): PromptSegment[] {
  const request = buildChatRequest(state, history);
  return [
    ...toolSegments(request, state),
    ...systemSegments(request, state),
    ...conversationSegments(request, state),
  ];
}
