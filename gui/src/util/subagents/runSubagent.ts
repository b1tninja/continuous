import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import type {
  ChatHistoryItem,
  ContextItem,
  LLMFullCompletionOptions,
  ModelDescription,
  SubagentRunState,
  Tool,
  ToolCallState,
  Usage,
} from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  findSubagent,
  SubagentDefinition,
} from "core/subagents/definitions";
import { resolveSubagentModel } from "core/subagents/model";
import type { AuditAgent } from "core/tools/permissions/audit/record";
import { subagentAuditAgent } from "core/tools/permissions/audit/identity";
import { modeModelFor } from "core/util/modelUse";
import {
  SubagentRunStatus,
  SubagentToolCallSummary,
  summarizeToolArgs,
} from "core/subagents/result";
import { sessionMessageText } from "core/subagents/messages";
import { resolveSubagentTools } from "core/subagents/tools";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  flagToolOutput,
  stripsHiddenCharacters,
} from "core/tools/permissions/injection";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import { renderChatMessage } from "core/util/messageContent";
import { selectCacheSetting } from "../../redux/selectors/selectCacheSetting";
import { selectActiveTools } from "../../redux/selectors/selectActiveTools";
import { selectApprovalSettings } from "../../redux/selectors/selectAutoApproval";
import { allowOutsideWorkspaceOf } from "../outsideEdits";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import {
  acceptToolCall,
  addRequestUsageToSession,
  cancelToolCall,
  errorToolCall,
  INITIAL_SESSION_STATE,
  sessionSlice,
  setProcessedToolCallArgs,
  setToolGenerated,
  streamUpdate,
  updateSubagentRun,
  updateToolCallOutput,
} from "../../redux/slices/sessionSlice";
import { evaluateToolPolicy } from "../../redux/thunks/evaluateToolPolicies";
import { findToolCallById } from "../../redux/util";
import { constructMessages } from "../../redux/util/constructMessages";
import type { IIdeMessenger } from "../../context/IdeMessenger";
import type {
  ClientToolExtras,
  ClientToolOutput,
} from "../clientTools/callClientTool";
import {
  INITIAL_PROMPT_CACHE_STATE,
  modelSupportsPromptCacheControl,
  promptCacheStatus,
  resolvePromptCache,
} from "../promptCache";
import { splitPromptProgress } from "../promptProgress";
import { subagentResultItem } from "./interrupt";
import {
  answerSessionTool,
  sessionToolsFor,
  subagentBatchOf,
} from "./sessionTools";
import {
  registerSubagentRun,
  STOPPED_BY_USER,
  subagentPrefixGate,
  subagentServerSlots,
  subagentSlots,
  takeInbox,
  waitForSubagentApproval,
  type SubagentInboxMessage,
} from "./registry";

const CANCELLED_BY_PARENT = "The parent conversation was stopped";

function reasonOf(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message)
    return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return CANCELLED_BY_PARENT;
}

const ABORTED = Symbol("aborted");

/** The promise's value, or ABORTED as soon as the signal aborts. */
function unlessAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** What two runs must share for one to read the other's cache entry. */
function prefixKey(
  model: ModelDescription,
  systemMessage: string,
  tools: Tool[],
): string {
  return JSON.stringify([
    model.title,
    systemMessage,
    tools.map((t) => t.function.name),
  ]);
}

/** The subagent's system prompt: what it is and how to report, then its own. */
export function buildSubagentSystemMessage(
  definition: SubagentDefinition,
  workspaceDirs: string[],
): string {
  const preamble = [
    `You are "${definition.name}", a subagent. Another agent gave you one task; it sees only your final message, not your tool calls or their output.`,
    "Work on the task with the tools you have. You cannot ask the person questions, and you cannot start subagents.",
    // Every run carries this sentence, whether or not a message comes, so
    // sibling runs keep one system prompt and one cached prefix
    'The person may send you messages, which arrive as user messages in <message from="person"> tags and never in tool output; follow them as you would the task.',
    "When you are done, reply with a self-contained report as your final message: the answer first, then the evidence (file paths and line numbers), then anything you could not finish.",
    workspaceDirs.length
      ? `Workspace folders: ${workspaceDirs.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  return definition.prompt ? `${preamble}\n\n${definition.prompt}` : preamble;
}

function addUsage(
  total: SubagentRunState["usage"],
  usage: Usage,
): SubagentRunState["usage"] {
  return {
    inputTokens: (total?.inputTokens ?? 0) + (usage.promptTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (usage.completionTokens ?? 0),
    cachedTokens:
      (total?.cachedTokens ?? 0) +
      (usage.promptTokensDetails?.cachedTokens ?? 0),
  };
}

/** Text of every assistant message so far; the last one when it finished. */
function assistantTexts(history: ChatHistoryItem[]): string[] {
  return history
    .filter((item) => item.message.role === "assistant")
    .map((item) => renderChatMessage(item.message).trim())
    .filter(Boolean);
}

/**
 * Messages as the subagent reads them: one user message, each in its own tag
 * so it is not mistaken for the parent's task, and one from another agent
 * labelled as not from the person (core/subagents/messages.ts).
 */
export function personMessageText(
  messages: readonly SubagentInboxMessage[],
): string {
  return sessionMessageText(messages);
}

/** How a message is kept in the run's record. */
function recordOf(
  m: SubagentInboxMessage,
  delivered: boolean,
): NonNullable<SubagentRunState["messages"]>[number] {
  return {
    text: m.text,
    at: m.at,
    delivered,
    ...(m.from?.kind === "agent" ? { from: m.from.name } : {}),
  };
}

function lastToolCalls(local: LocalSession): ToolCallState[] {
  const last = local.history[local.history.length - 1];
  return last?.message.role === "assistant" ? (last.toolCallStates ?? []) : [];
}

function errorItem(message: string): ContextItem[] {
  return [
    {
      icon: "problems",
      name: "Tool Call Error",
      description: "Tool Call Failed",
      content: message,
      hidden: false,
    },
  ];
}

interface RunArgs {
  agent: string;
  prompt: string;
  description?: string;
}

function parseArgs(args: any): RunArgs {
  const agent = typeof args?.agent === "string" ? args.agent.trim() : "";
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (!agent || !prompt) {
    throw new ContinueError(
      ContinueErrorReason.Unspecified,
      'The subagent tool needs "agent" and "prompt"',
    );
  }
  return {
    agent,
    prompt,
    description:
      typeof args?.description === "string" ? args.description : undefined,
  };
}

/** A tool call the runner answers itself, instead of sending it to core. */
export interface HandledCall {
  output: ContextItem[];
  /** The run ends after this turn's calls (a Loop worker's finish_item) */
  endRun?: boolean;
}

/** The conversation a run drives: a fresh session with the prompt as its first message. */
export type LocalSession = ReturnType<typeof sessionSlice.reducer>;

export function newLocalSession(prompt: string): LocalSession {
  return {
    ...INITIAL_SESSION_STATE,
    history: [
      {
        message: { role: "user", content: prompt, id: "subagent-prompt" },
        contextItems: [],
      },
    ],
  };
}

export interface SubagentDriveInput {
  ideMessenger: IIdeMessenger;
  dispatch: ClientToolExtras["dispatch"];
  getState: ClientToolExtras["getState"];
  /** Aborting it cancels the run; the system tool framework also uses it */
  controller: AbortController;
  /** The run's conversation so far (newLocalSession for a fresh one) */
  local: LocalSession;
  systemMessage: string;
  model: ModelDescription;
  tools: Tool[];
  framework?: SystemMessageToolCodeblocksFramework;
  completionOptions: LLMFullCompletionOptions;
  /** Prompt caching is on: the first request waits its turn at the prefix gate */
  cachingOn: boolean;
  maxTurns: number;
  /** The run's live state: the parent's card, or a Loop worker's inbox row */
  onUpdate: (patch: Partial<SubagentRunState>) => void;
  /** Ids of this run's approvals start with it (the parent's tool call id) */
  approvalScope: string;
  /**
   * A call the parent's policies would ask about: wait for the person on the
   * card (default), or refuse it, for a run nobody answers (a Loop worker)
   */
  approvals?: "card" | "refuse";
  /**
   * Calls the runner answers itself, before the parent's policies: a Loop
   * worker's finish_item, hold_question and remind_me. Undefined sends the
   * call to core as usual.
   */
  handleCall?: (call: ToolCallState) => Promise<HandledCall | undefined>;
  /**
   * Calls the gui answers itself, after the parent's policies allowed them
   * (asked the person, at Careful): list_sessions and send_message. Undefined
   * for a tool sends the call to core.
   */
  localCall?: (call: ToolCallState) => Promise<ContextItem[] | undefined>;
  /** Folders (URIs) the tool calls run in: a worker's worktree */
  workspaceDirs?: string[];
  /** Who the audit trail names for this run's calls, under the parent's session */
  audit?: { sessionId: string; agent: AuditAgent };
  /**
   * The run's message queue in the registry (the parent's tool call id).
   * Undefined for a run nobody messages (a Loop worker).
   */
  inboxId?: string;
}

export interface SubagentDriveResult {
  status: SubagentRunStatus;
  error?: string;
  /** The conversation as it ended */
  local: LocalSession;
  toolCalls: SubagentToolCallSummary[];
  usage?: SubagentRunState["usage"];
}

/**
 * Wait for a subagent slot, and for one of the model server's own slots when
 * the server says how many it has: a one-slot local server runs one
 * subagent at a time. Resolves with a release for both.
 */
export async function acquireSubagentSlots(
  ideMessenger: IIdeMessenger,
  model: ModelDescription,
  signal: AbortSignal,
): Promise<() => void> {
  // A cancelled run gives up its place in the queue
  const release = await subagentSlots.acquire(signal);
  let releaseServer: (() => void) | undefined;
  try {
    const serverLimit = model.apiBase
      ? await ideMessenger
          .request("models/serverConcurrency", { title: model.title })
          .then((res) => (res.status === "success" ? res.content : undefined))
          .catch(() => undefined)
      : undefined;
    if (model.apiBase && serverLimit) {
      releaseServer = await subagentServerSlots(
        model.apiBase,
        serverLimit,
      ).acquire(signal);
    }
  } catch (e) {
    release();
    throw e;
  }
  return () => {
    releaseServer?.();
    release();
  };
}

/**
 * The request loop of a subagent run: model calls until the reply has no
 * tool calls, the turn limit, or the signal; every call checked with the
 * parent's policies and run through core (or answered by `handleCall`). The
 * tool output never leaves the run's own conversation. Shared by the
 * parent's `subagent` tool and Loop mode's workers.
 */
export async function driveSubagent(
  input: SubagentDriveInput,
): Promise<SubagentDriveResult> {
  const {
    ideMessenger,
    dispatch,
    getState,
    controller,
    systemMessage,
    model,
    tools,
    framework,
    completionOptions,
    cachingOn,
    maxTurns,
    onUpdate,
  } = input;
  const signal = controller.signal;
  let local = input.local;
  const reduce = (action: Parameters<typeof sessionSlice.reducer>[1]) => {
    local = sessionSlice.reducer(local, action);
  };
  let toolCalls: SubagentToolCallSummary[] = [];
  let usage: SubagentRunState["usage"];
  const update = (patch: Partial<SubagentRunState>) => {
    if (patch.toolCalls) toolCalls = patch.toolCalls;
    if (patch.usage) usage = patch.usage;
    onUpdate(patch);
  };
  const result = (
    status: SubagentRunStatus,
    error?: string,
  ): SubagentDriveResult => ({ status, error, local, toolCalls, usage });
  // The person's messages, appended as one user message for the next request
  let sent: NonNullable<SubagentRunState["messages"]> = [];
  const deliver = (messages: SubagentInboxMessage[]) => {
    if (messages.length === 0) return;
    local = {
      ...local,
      history: [
        ...local.history,
        {
          message: {
            role: "user",
            content: personMessageText(messages),
            id: `subagent-message-${messages[0].id}`,
          },
          contextItems: [],
        },
      ],
    };
    sent = [...sent, ...messages.map((m) => recordOf(m, true))];
    update({ messages: sent });
  };

  for (let turn = 1; ; turn++) {
    if (signal.aborted) return result("cancelled", reasonOf(signal));
    if (turn > maxTurns) {
      return result("partial", `Stopped after ${maxTurns} model calls`);
    }

    const messages = constructMessages(
      local.history.map(({ message: { id, ...message }, ...rest }) => ({
        ...rest,
        message,
      })) as ChatHistoryItem[],
      systemMessage,
      [],
      {},
      framework,
    ).messages;

    // Siblings with the same model, system prompt and tools share a cached
    // prefix: the first one's request goes alone so the rest can read it.
    const gate =
      turn === 1 && cachingOn
        ? await subagentPrefixGate.enter(
            prefixKey(model, systemMessage, tools),
            signal,
          )
        : undefined;
    try {
      // Stopped while waiting for the gate: send nothing
      if (signal.aborted) return result("cancelled", reasonOf(signal));
      let gen = ideMessenger.llmStreamChat(
        { completionOptions, title: model.title, messages },
        signal,
      );
      if (framework) {
        gen = interceptSystemToolCalls(gen, controller, framework);
      }
      let next = await gen.next();
      while (!next.done) {
        gate?.opened();
        if (signal.aborted) break;
        // A server's prompt-reading updates are not part of the reply
        const { reply } = splitPromptProgress(next.value);
        if (reply.length > 0) reduce(streamUpdate(reply));
        for (const message of next.value) {
          if (message.role === "assistant" && message.usage) {
            update({ usage: addUsage(usage, message.usage) });
            dispatch(
              addRequestUsageToSession({
                provider: model.provider,
                model: model.model,
                usage: message.usage,
              }),
            );
          }
        }
        update({ text: assistantTexts(local.history).join("\n\n") });
        next = await gen.next();
      }
    } finally {
      gate?.opened();
    }
    if (signal.aborted) return result("cancelled", reasonOf(signal));

    const calls = lastToolCalls(local);
    if (calls.length === 0) {
      // Would finish: messages still queued keep the run going, one more
      // model call that counts against the turn limit. With no call left,
      // they stay queued and are reported as not delivered.
      const waiting =
        input.inboxId && turn < maxTurns ? takeInbox(input.inboxId, "all") : [];
      if (waiting.length === 0) return result("completed");
      deliver(waiting);
      continue;
    }
    for (const call of calls) {
      reduce(setToolGenerated({ toolCallId: call.toolCallId, tools }));
    }
    let ended = false;
    for (const call of lastToolCalls(local)) {
      if (signal.aborted) {
        reduce(cancelToolCall({ toolCallId: call.toolCallId }));
        continue;
      }
      if (await runChildToolCall(call)) ended = true;
    }
    // A tool message after the calls, as the parent's history has, so the
    // next answer starts a new assistant message. Its content is rebuilt
    // from the call's output when the request is assembled.
    for (const call of lastToolCalls(local)) {
      reduce(
        streamUpdate([
          { role: "tool", content: "", toolCallId: call.toolCallId },
        ]),
      );
    }
    if (ended) return result("completed");
    // Tool boundary: "Send now" messages go in after the tool results, before
    // the next request, as the main chat's steering does
    if (input.inboxId && !signal.aborted && turn < maxTurns) {
      deliver(takeInbox(input.inboxId, "steer"));
    }
  }

  /** Runs one call; true when it ends the run (HandledCall.endRun). */
  async function runChildToolCall(call: ToolCallState): Promise<boolean> {
    const name = call.toolCall.function.name;
    const summary: SubagentToolCallSummary = {
      name,
      summary: maskCommandForDisplay(summarizeToolArgs(call.parsedArgs)),
      status: "calling",
    };
    const index = toolCalls.length;
    const setCallStatus = (status: SubagentToolCallSummary["status"]) => {
      const next = [...toolCalls];
      next[index] = { ...summary, status };
      update({ toolCalls: next });
    };
    update({ toolCalls: [...toolCalls, summary] });

    const fail = (message: string) => {
      reduce(
        errorToolCall({
          toolCallId: call.toolCallId,
          output: errorItem(message),
        }),
      );
      setCallStatus("errored");
    };
    const succeed = (items: ContextItem[]) => {
      reduce(
        updateToolCallOutput({
          toolCallId: call.toolCallId,
          contextItems: items,
        }),
      );
      reduce(acceptToolCall({ toolCallId: call.toolCallId }));
      setCallStatus("done");
    };

    if (!tools.some((t) => t.function.name === name)) {
      fail(`${name} is not available to this subagent.`);
      return false;
    }

    try {
      const handled = await input.handleCall?.(call);
      if (handled) {
        succeed(handled.output);
        return !!handled.endRun;
      }

      let current = findLocalCall(call.toolCallId) ?? call;
      const pre = await ideMessenger.request("tools/preprocessArgs", {
        toolName: name,
        args: current.parsedArgs ?? {},
        ...(input.workspaceDirs ? { workspaceDirs: input.workspaceDirs } : {}),
        ...(allowOutsideWorkspaceOf(getState())
          ? { allowOutsideWorkspace: true }
          : {}),
      });
      if (pre.status === "success") {
        if (pre.content.errorMessage) {
          fail(pre.content.errorMessage);
          return false;
        }
        if (pre.content.preprocessedArgs) {
          reduce(
            setProcessedToolCallArgs({
              toolCallId: call.toolCallId,
              newArgs: pre.content.preprocessedArgs,
            }),
          );
        }
      }
      current = findLocalCall(call.toolCallId) ?? current;

      const policy = await evaluateToolPolicy(
        ideMessenger,
        tools,
        current,
        getState().ui.toolSettings,
        selectApprovalSettings(getState()),
        getState().session.mode,
        input.audit?.sessionId,
        input.audit?.agent,
      );
      if (policy.policy === "disabled") {
        fail(
          `${name} was refused by the person's tool policies${
            policy.reason ? `: ${policy.reason}` : ""
          }.`,
        );
        return false;
      }
      if (policy.policy === "allowedWithPermission") {
        if (input.approvals === "refuse") {
          fail(
            `${name} needs the person's approval, and nobody can give it during this run. Do what you can without it; if the item cannot be done without it, report it as waiting and say what needs approval.`,
          );
          return false;
        }
        const approvalId = `${input.approvalScope}:${call.toolCallId}`;
        update({
          pendingApproval: {
            id: approvalId,
            toolName: name,
            summary: policy.displayValue ?? summary.summary,
            ...(policy.reason && { note: policy.reason }),
          },
        });
        const allowed = await waitForSubagentApproval(approvalId, signal);
        update({ pendingApproval: undefined });
        if (!allowed) {
          reduce(cancelToolCall({ toolCallId: call.toolCallId }));
          setCallStatus("canceled");
          return false;
        }
      }

      const answered = signal.aborted
        ? undefined
        : await input.localCall?.(current);
      if (answered) {
        succeed(answered);
        return false;
      }

      // Stop does not wait for the call: core cannot cancel a tool call, so
      // its result is dropped, and a terminal command is killed as the
      // parent's own Stop does.
      const result = await unlessAborted(
        ideMessenger.request("tools/call", {
          toolCall: current.toolCall,
          ...(input.workspaceDirs
            ? { workspaceDirs: input.workspaceDirs }
            : {}),
          ...(allowOutsideWorkspaceOf(getState())
            ? { allowOutsideWorkspace: true }
            : {}),
        }),
        signal,
      );
      if (result === ABORTED) {
        if (name === BuiltInToolNames.RunTerminalCommand) {
          void ideMessenger
            .request("process/killTerminalProcess", {
              toolCallId: call.toolCallId,
            })
            .catch(() => {});
        }
        reduce(cancelToolCall({ toolCallId: call.toolCallId }));
        setCallStatus("canceled");
        return false;
      }
      if (result.status === "error") {
        fail(result.error);
        return false;
      }
      if (result.content.errorMessage) {
        fail(`${name} failed with the message: ${result.content.errorMessage}`);
        return false;
      }
      const { items } = flagToolOutput(result.content.contextItems ?? [], {
        stripHidden: stripsHiddenCharacters(name, call.tool?.uri),
      });
      succeed(items);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return false;
  }

  function findLocalCall(id: string): ToolCallState | undefined {
    return lastToolCalls(local).find((c) => c.toolCallId === id);
  }
}

/**
 * How a run's requests go to this model: native tools or the system message
 * framework, and prompt caching as the parent has it for this model. A fresh
 * cache state, so "auto" starts at 5 minutes: a run's requests come seconds
 * apart, and nothing here learns from them.
 */
export function prepareSubagentRequests(
  state: ReturnType<ClientToolExtras["getState"]>,
  model: ModelDescription,
  tools: Tool[],
  baseSystem: string,
): Pick<
  SubagentDriveInput,
  "systemMessage" | "framework" | "completionOptions" | "cachingOn"
> {
  const useNativeTools = state.config.config.experimental
    ?.onlyUseSystemMessageTools
    ? false
    : modelSupportsNativeTools(model);
  const framework =
    !useNativeTools && tools.length > 0
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;
  const systemMessage = framework
    ? addSystemMessageToolsToSystemMessage(framework, baseSystem, tools)
    : baseSystem;
  const parentModel = selectSelectedChatModel(state);
  const cacheSetting =
    model.title === parentModel?.title ? selectCacheSetting(state) : undefined;
  const cacheOptions = resolvePromptCache(
    model,
    cacheSetting,
    INITIAL_PROMPT_CACHE_STATE,
    Date.now(),
    state.session.mode,
  ).options;
  const cachingOn =
    modelSupportsPromptCacheControl(model) &&
    promptCacheStatus(model, cacheSetting, INITIAL_PROMPT_CACHE_STATE, 0).on;
  const completionOptions: LLMFullCompletionOptions = {
    ...(useNativeTools && tools.length > 0 ? { tools } : {}),
    ...cacheOptions,
  };
  return { systemMessage, framework, completionOptions, cachingOn };
}

/**
 * Run a subagent for the parent's `subagent` tool call: a fresh conversation
 * with the agent's system prompt and the parent's tools narrowed by the
 * definition, driven from the gui because that is where the parent's tool
 * policies, approval UI and stop button live. Every call the subagent makes
 * is checked with the parent's policies; one the parent would ask about waits
 * for the person on the card. Its tool output never leaves this function: the
 * parent gets the answer and a `<task_metadata>` block.
 */
export async function runSubagentTool(
  rawArgs: any,
  toolCallId: string,
  { dispatch, getState, ideMessenger }: ClientToolExtras,
): Promise<ClientToolOutput> {
  const args = parseArgs(rawArgs);

  // Stop on the parent (and switching sessions) aborts this signal; the
  // card's Stop aborts only this run.
  const parentSignal = getState().session.streamAborter.signal;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(new Error(CANCELLED_BY_PARENT));
  if (parentSignal.aborted) onParentAbort();
  else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const unregister = registerSubagentRun(toolCallId, controller);
  const signal = controller.signal;

  let run: SubagentRunState = {
    agent: args.agent,
    prompt: args.prompt,
    description: args.description,
    status: "queued",
    toolCalls: [],
    text: "",
  };
  const update = (patch: Partial<SubagentRunState>) => {
    run = { ...run, ...patch };
    dispatch(updateSubagentRun({ toolCallId, run: patch }));
  };
  update(run);

  let release: (() => void) | undefined;
  let local: LocalSession = newLocalSession(args.prompt);

  const finish = (status: SubagentRunStatus, error?: string) => {
    const texts = assistantTexts(local.history);
    const lastCalls = lastToolCalls(local);
    // A finished run's answer is its last message; any other run returns
    // everything it wrote, so a stopped run still hands back its findings.
    const text =
      status === "completed" && lastCalls.length === 0
        ? (texts[texts.length - 1] ?? "")
        : texts.join("\n\n");
    update({
      status,
      text,
      error,
      pendingApproval: undefined,
      endedAt: Date.now(),
      toolCalls: run.toolCalls.map((c) =>
        c.status === "calling" ? { ...c, status: "canceled" } : c,
      ),
    });
  };

  try {
    const listed = await ideMessenger.request("subagents/list", undefined);
    if (listed.status === "error") throw new Error(listed.error);
    const definition = findSubagent(listed.content.agents, args.agent);
    if (!definition) {
      throw new ContinueError(
        ContinueErrorReason.Unspecified,
        [
          `No subagent named "${args.agent}". Available: ${listed.content.agents
            .map((a) => a.name)
            .join(", ")}.`,
          ...listed.content.errors.map((e) => `Could not load ${e}`),
        ].join(" "),
      );
    }
    update({ agent: definition.name });

    const state = getState();
    const parentModel = selectSelectedChatModel(state);
    if (!parentModel) throw new Error("No chat model selected");
    // A definition that names no model gets `modeModels.subagent` when the
    // config sets it, else the model of the turn that started it
    const chatModels = state.config.config.modelsByRole?.chat ?? [];
    const configured = modeModelFor(state.config.config.modeModels, "subagent");
    const defaultModel =
      chatModels.find((m) => m.title === configured?.title) ?? parentModel;
    const { model, fallbackReason } = resolveSubagentModel(
      definition.model,
      chatModels,
      defaultModel,
    );

    // The parent's tools for its mode (disabled tools and groups already
    // removed), with this model's overrides, narrowed by the definition.
    let parentTools = selectActiveTools(state);
    if (model.toolOverrides?.length) {
      parentTools = applyToolOverrides(parentTools, model.toolOverrides).tools;
    }
    const resolved = resolveSubagentTools(definition, parentTools);
    // Started with other subagents: it may list them and message them
    const batchSize = subagentBatchOf(state.session.history, toolCallId).length;
    const tools = [
      ...resolved.tools,
      ...sessionToolsFor(definition, batchSize),
    ];
    const notices = [
      ...(fallbackReason ? [fallbackReason] : []),
      // Built-in agents list tools that only some setups have; only a
      // definition someone wrote is worth a note about a missing tool.
      ...(resolved.unmatched.length && definition.source !== "built-in"
        ? [`Not available here: ${resolved.unmatched.join(", ")}`]
        : []),
    ];
    update({ model: model.title, ...(notices.length && { notices }) });

    const workspaceDirs = await ideMessenger.ide
      .getWorkspaceDirs()
      .catch(() => [] as string[]);
    const prepared = prepareSubagentRequests(
      state,
      model,
      tools,
      buildSubagentSystemMessage(definition, workspaceDirs),
    );

    release = await acquireSubagentSlots(ideMessenger, model, signal);
    update({ status: "running", startedAt: Date.now() });

    const outcome = await driveSubagent({
      ideMessenger,
      dispatch,
      getState,
      controller,
      local,
      model,
      tools,
      ...prepared,
      maxTurns: definition.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      onUpdate: update,
      approvalScope: toolCallId,
      inboxId: toolCallId,
      localCall: async (call) =>
        answerSessionTool(
          call,
          { runId: toolCallId, name: definition.name },
          getState,
        ),
      audit: {
        sessionId: getState().session.id,
        agent: subagentAuditAgent(
          getState().session.id,
          toolCallId,
          definition.name,
          getState().session.mode,
        ),
      },
    });
    local = outcome.local;
    finish(outcome.status, outcome.error);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (signal.aborted) finish("cancelled", reasonOf(signal));
    else finish("failed", message);
  } finally {
    release?.();
    unregister();
    parentSignal.removeEventListener("abort", onParentAbort);
  }

  // Messages the run ended before reading: kept in its record as not
  // delivered, and said on the card. No message can be queued after this
  // point, because the run is no longer live.
  const undelivered = takeInbox(toolCallId, "all");
  if (undelivered.length > 0) {
    const n = undelivered.length;
    update({
      messages: [
        ...(run.messages ?? []),
        ...undelivered.map((m) => recordOf(m, false)),
      ],
      notices: [
        ...(run.notices ?? []),
        `${n === 1 ? "Your message was" : `${n} of your messages were`} not delivered: the run ended first.`,
      ],
    });
  }

  // The session was reloaded in this window while the run wound down: it was
  // marked interrupted with what it had, and that result stands.
  const loaded = findToolCallById(getState().session.history, toolCallId);
  if (loaded?.subagent?.status === "interrupted") {
    return { output: loaded.output, respondImmediately: false };
  }

  const output = [subagentResultItem(run)];
  if (parentSignal.aborted) {
    // The person stopped the parent: record the result, but do not start
    // another model call for it.
    dispatch(acceptToolCall({ toolCallId }));
    return { output, respondImmediately: false };
  }
  return { output, respondImmediately: true };
}
