import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { LLMFullCompletionOptions } from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { totalInputTokens } from "core/llm/utils/cacheStats";
import { ToCoreProtocol } from "core/protocol";
import { renderChatMessage } from "core/util/messageContent";
import { buildLedgerEntry } from "../../util/cacheLedger";
import {
  detectCacheMiss,
  expectedRebuildCauses,
  expectedRoute,
  promptCacheKey,
} from "../../util/cacheSafeguards";
import { localCacheWarmMs } from "../../util/localWarmWindow";
import {
  INITIAL_PROMPT_CACHE_STATE,
  modelSupportsOneHourCache,
  modelSupportsPromptCacheControl,
  modelUsesLocalPrefixCache,
  promptCacheStatus,
  resolvePromptCache,
} from "../../util/promptCache";
import { splitPromptProgress } from "../../util/promptProgress";
import { selectCacheSetting } from "../selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  abortStream,
  addPromptCompletionPair,
  addRequestUsageToSession,
  errorToolCall,
  recordCacheMiss,
  recordCacheRequest,
  requestQueuedMessagesSend,
  setActive,
  setAnsweredRoute,
  setAppliedRulesAtIndex,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setPromptCacheInputTokens,
  setPromptCacheKey,
  setPromptCacheRequestAt,
  setPromptCacheState,
  setPromptProgress,
  setPromptReadSpeed,
  setRecoveryHold,
  setToolGenerated,
  streamUpdate,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { buildChatRequest } from "../util/buildChatRequest";
import { dumpPromptSegments } from "../util/promptSegmentDump";

import { mainAuditAgent } from "core/tools/permissions/audit/identity";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";

import { localOutputLimit } from "core/llm/outputLimit";
import { allowOutsideWorkspaceOf } from "../../util/outsideEdits";
import {
  selectApprovalSettings,
  selectAutoApproval,
} from "../selectors/selectAutoApproval";
import {
  selectCurrentToolCalls,
  selectPendingToolCalls,
} from "../selectors/selectToolCalls";
import { callToolById } from "./callToolById";
import { cancelStream } from "./cancelStream";
import {
  buildReviewHistory,
  evaluateToolPolicies,
} from "./evaluateToolPolicies";
import { applyLoopHolds, endRunAtTurnLimit } from "./loopHolds";
import { checkToolDialectLeak } from "./noteToolDialectLeak";
import { nudgeLeakedToolCall } from "./nudgeLeakedToolCall";
import {
  preprocessToolCalls,
  refuseTruncatedToolCalls,
} from "./preprocessToolCallArgs";
import { refuseRoleCalls } from "./refuseRoleCalls";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const streamNormalInput = createAsyncThunk<
  void,
  {
    legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
    depth?: number;
  },
  ThunkApiType
>(
  "chat/streamNormalInput",
  async (
    { legacySlashCommandData, depth = 0 },
    { dispatch, extra, getState },
  ) => {
    if (process.env.NODE_ENV === "test" && depth > 50) {
      const message = `Max stream depth of ${50} reached in test`;
      console.error(message, JSON.stringify(getState(), null, 2));
      throw new Error(message);
    }
    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    // Tools, reasoning, system message and messages: one function builds them,
    // and the compaction request calls it too, so the two start with the same bytes.
    const {
      activeTools,
      completionOptions: builtOptions,
      messages,
      taskListMessage,
      appliedRules,
      appliedRuleIndex,
      systemToolsFramework,
    } = buildChatRequest(state);
    dumpPromptSegments(state);
    let completionOptions: LLMFullCompletionOptions = builtOptions;

    // Prompt caching: the toolbar choice for this model, or when there is none
    // the default for this mode (see effectiveCacheSetting). Auto learns from
    // the pauses between requests this session.
    const cacheStateBefore =
      state.session.promptCache ?? INITIAL_PROMPT_CACHE_STATE;
    const cacheSetting = selectCacheSetting(state);
    // A local server caches every prompt on its own, with no setting
    const localCache = modelUsesLocalPrefixCache(selectedChatModel);
    const cachingWasOn =
      localCache ||
      (modelSupportsPromptCacheControl(selectedChatModel) &&
        promptCacheStatus(selectedChatModel, cacheSetting, cacheStateBefore, 0)
          .on);
    const cacheResolution = resolvePromptCache(
      selectedChatModel,
      cacheSetting,
      cacheStateBefore,
      Date.now(),
      state.session.mode,
    );
    completionOptions = { ...completionOptions, ...cacheResolution.options };
    if (cacheResolution.nextState !== state.session.promptCache) {
      dispatch(setPromptCacheState(cacheResolution.nextState));
    }

    // What the cached prefix is made of: the model, the tools and the system
    // prompt. A change to any of them rebuilds the cache. The system prompt is
    // the final one: base message, matched rules and any conversation summary,
    // so a rule that starts to match is noticed.
    // A model with routes has a cache per account, so the key names the
    // route; if another route answers, the key is rebuilt with that one.
    const finalSystem = messages.find((m) => m.role === "system");
    const cacheKeyFor = (route: string | undefined) =>
      promptCacheKey(
        selectedChatModel,
        activeTools,
        finalSystem ? renderChatMessage(finalSystem) : undefined,
        // Each message after the system one, so an edit or removal of an earlier
        // message is told apart from a conversation that only grew.
        messages.filter((m) => m.role !== "system"),
        { route, options: completionOptions },
      );
    const routeExpected = expectedRoute(
      selectedChatModel,
      cacheStateBefore.lastKey,
    );
    const cacheKey = cacheKeyFor(routeExpected);

    // TODO parallel tool calls will cause issues with this
    // because there will be multiple tool messages, so which one should have applied rules?
    dispatch(
      setAppliedRulesAtIndex({
        index: appliedRuleIndex,
        appliedRules: appliedRules,
      }),
    );

    dispatch(setActive());
    dispatch(setInlineErrorMessage(undefined));

    // The task list goes last, after the history and after the conversation's
    // cache point, so a change to it leaves the cached prefix untouched (see
    // core/util/taskPlan.ts). It is not part of the cache key above.
    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages: taskListMessage ? [...messages, taskListMessage] : messages,
      options: completionOptions,
    });

    if (precompiledRes.status === "error") {
      if (precompiledRes.error.includes("Not enough context")) {
        dispatch(setInlineErrorMessage("out-of-context"));
        dispatch(setInactive());
        return;
      } else {
        throw new Error(precompiledRes.error);
      }
    }

    const {
      compiledChatMessages,
      didPrune,
      didAge,
      contextPercentage,
      outputTokensAvailable,
    } = precompiledRes.content;

    // A local model with no configured limit may use the room that is left,
    // so a large tool call is not cut off for no gain
    const localMaxTokens = localOutputLimit({
      apiBase: selectedChatModel.apiBase,
      maxTokens:
        completionOptions.maxTokens ??
        selectedChatModel.completionOptions?.maxTokens,
      outputTokensAvailable,
    });
    if (localMaxTokens) {
      completionOptions = { ...completionOptions, maxTokens: localMaxTokens };
    }

    dispatch(setIsPruned(didPrune));
    dispatch(setContextPercentage(contextPercentage));

    const start = Date.now();
    const streamAborter = state.session.streamAborter;
    // The reply's stop reason, from the usage on its last chunk: it tells a
    // tool call cut off at the output limit from one that arrived incomplete
    let lastStopReason: string | undefined;
    try {
      let gen = extra.ideMessenger.llmStreamChat(
        {
          completionOptions,
          title: selectedChatModel.title,
          messages: compiledChatMessages,
          legacySlashCommandData,
          messageOptions: { precompiled: true },
        },
        streamAborter.signal,
      );
      if (systemToolsFramework && activeTools.length > 0) {
        gen = interceptSystemToolCalls(
          gen,
          streamAborter,
          systemToolsFramework,
        );
      }

      let next = await gen.next();
      while (!next.done) {
        // A request that was replaced (Stop, a retry, a new turn) stops here
        // even when a newer one has set isStreaming again: its chunks would
        // otherwise land in the newer turn's history, attached to its calls
        if (!getState().session.isStreaming || streamAborter.signal.aborted) {
          dispatch(abortStream());
          break;
        }

        // A local server's prompt-reading updates go to the toolbar, not the
        // conversation; the first part of the reply clears them
        const { progress, hold, reply } = splitPromptProgress(next.value);
        if (progress) {
          dispatch(setPromptProgress(progress));
        } else if (getState().session.promptProgress) {
          dispatch(setPromptProgress(undefined));
        }
        // A reply held for tool call recovery shows a line while it is held;
        // the hold ending, or any of the reply arriving, clears it
        if (hold === "start") dispatch(setRecoveryHold(true));
        else if (
          (hold === "end" || reply.length > 0) &&
          getState().session.recoveryHold
        ) {
          dispatch(setRecoveryHold(false));
        }
        if (reply.length > 0) dispatch(streamUpdate(reply));

        // The final chunk carries the API's token counts. Remember the input
        // size so the cache button can say what throwing the cache away costs,
        // and check that a cache that should have been warm was read.
        for (const message of next.value) {
          if (
            message.role === "assistant" &&
            message.usage?.response?.stopReason
          ) {
            lastStopReason = message.usage.response.stopReason;
          }
          if (message.role === "assistant" && message.usage) {
            const key =
              message.route && message.route !== routeExpected
                ? cacheKeyFor(message.route)
                : cacheKey;
            if (message.route) {
              dispatch(
                setAnsweredRoute({
                  model: selectedChatModel.title,
                  route: message.route,
                }),
              );
            }
            // A model with routes: the account that answered, priced as
            // that account's provider and model id
            const usageProvider =
              message.routeProvider ?? selectedChatModel.provider;
            const usageModel = message.routeModel ?? selectedChatModel.model;
            const total = totalInputTokens(
              usageProvider,
              usageModel,
              message.usage,
            );
            if (total > 0) {
              let missCauses: string[] | undefined;
              if (cachingWasOn) {
                const request = {
                  before: cacheStateBefore,
                  key,
                  requestAt: localCache
                    ? start
                    : (cacheResolution.nextState.lastRequestAt ?? start),
                  ...(localCache && {
                    lifetimeMs: localCacheWarmMs(selectedChatModel),
                  }),
                  readTokens:
                    message.usage.promptTokensDetails?.cachedTokens ?? 0,
                  totalInputTokens: total,
                };
                const miss = detectCacheMiss({
                  ...request,
                  pruned: didPrune,
                  aged: didAge,
                });
                if (miss) {
                  missCauses = miss.causes;
                  dispatch(
                    recordCacheMiss({
                      readTokens: miss.readTokens,
                      expectedTokens: miss.expectedTokens,
                      causes: miss.causes,
                    }),
                  );
                } else {
                  // Not a fault, but the cache was not read either: a model
                  // switch or a shortened conversation. Recorded so the
                  // session summary can count it as an expected rebuild.
                  missCauses = expectedRebuildCauses({
                    ...request,
                    aged: didAge,
                  });
                }
              }
              // One in-memory record per request, for the session's own
              // statistics. Counts and timings only.
              dispatch(
                recordCacheRequest(
                  buildLedgerEntry({
                    at: start,
                    mode: state.session.mode,
                    provider: usageProvider,
                    model: usageModel,
                    cachingOn: !!cachingWasOn,
                    ttl: cacheResolution.nextState.lastTtl,
                    oneHour: modelSupportsOneHourCache(selectedChatModel),
                    usage: message.usage,
                    pruned: didPrune,
                    missCauses,
                  }),
                ),
              );
              dispatch(setPromptCacheInputTokens(total));
              dispatch(setPromptCacheKey(key));
              if (localCache) {
                dispatch(setPromptCacheRequestAt(start));
                // Only a read of some size says much about the speed
                const speed = message.usage.promptTokensPerSecond;
                const read =
                  total -
                  (message.usage.promptTokensDetails?.cachedTokens ?? 0);
                if (speed && read >= 1000) dispatch(setPromptReadSpeed(speed));
              }
            }
            dispatch(
              addRequestUsageToSession({
                provider: usageProvider,
                model: usageModel,
                usage: message.usage,
              }),
            );
          }
        }
        next = await gen.next();
      }
      if (getState().session.promptProgress) {
        dispatch(setPromptProgress(undefined));
      }
      if (getState().session.recoveryHold) dispatch(setRecoveryHold(false));

      if (next.done) {
        void checkToolDialectLeak(getState(), dispatch, extra.ideMessenger);
      }

      // Attach prompt log and end thinking for reasoning models
      if (next.done && next.value) {
        dispatch(addPromptCompletionPair([next.value]));

        try {
          extra.ideMessenger.post("devdata/log", {
            name: "chatInteraction",
            data: {
              prompt: next.value.prompt,
              completion: next.value.completion,
              modelProvider: selectedChatModel.underlyingProviderName,
              modelName: selectedChatModel.title,
              modelTitle: selectedChatModel.title,
              sessionId: state.session.id,
              ...(!!activeTools.length && {
                tools: activeTools.map((tool) => tool.function.name),
              }),
              ...(appliedRules.length > 0 && {
                rules: appliedRules.map((rule) => ({
                  id: getRuleId(rule),
                  slug: rule.slug,
                })),
              }),
            },
          });
        } catch (e) {
          console.error("Failed to send dev data interaction log", e);
        }
      }
    } catch (e) {
      const toolCallsToCancel = selectCurrentToolCalls(getState());
      if (
        toolCallsToCancel.length > 0 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("premature close")
      ) {
        for (const tc of toolCallsToCancel) {
          dispatch(
            errorToolCall({
              toolCallId: tc.toolCallId,
              output: [
                {
                  name: "Tool Call Error",
                  description: "Premature Close",
                  content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                  icon: "problems",
                },
              ],
            }),
          );
        }
      } else {
        throw e;
      }
    }

    // Tool call sequence:
    // 1. Mark generating tool calls as generated
    const state1 = getState();
    if (streamAborter.signal.aborted || !state1.session.isStreaming) {
      return;
    }
    const originalToolCalls = selectCurrentToolCalls(state1);
    const generatingCalls = originalToolCalls.filter(
      (tc) => tc.status === "generating",
    );
    for (const { toolCallId } of generatingCalls) {
      dispatch(
        setToolGenerated({
          toolCallId,
          tools: state1.config.config.tools,
        }),
      );
    }

    // A call cut off at the output limit must not run with partial arguments;
    // the stop reason tells a real cut from arguments that arrived incomplete
    refuseTruncatedToolCalls(
      dispatch,
      selectPendingToolCalls(getState()),
      completionOptions.maxTokens ??
        selectedChatModel.completionOptions?.maxTokens,
      lastStopReason,
    );

    // A call to a tool the mode's role may not use is refused, offered or not
    refuseRoleCalls(dispatch, selectPendingToolCalls(getState()), {
      mode: state1.session.mode,
      tools: state1.config.config.tools,
      planMcpTools: state1.ui.policyExtras.planMcpTools,
      trustedMcpServers: state1.ui.policyExtras.trustedMcpServers,
    });

    // 2. Pre-process args to catch invalid args before checking policies
    const state2 = getState();
    if (streamAborter.signal.aborted || !state2.session.isStreaming) {
      return;
    }
    const generatedCalls2 = selectPendingToolCalls(state2);
    await preprocessToolCalls(
      dispatch,
      extra.ideMessenger,
      generatedCalls2,
      allowOutsideWorkspaceOf(state2),
    );

    // 3. Security check: evaluate updated policies based on args
    const state3 = getState();
    if (streamAborter.signal.aborted || !state3.session.isStreaming) {
      return;
    }
    const generatedCalls3 = selectPendingToolCalls(state3);
    const toolPolicies = state3.ui.toolSettings;
    const evaluated = await evaluateToolPolicies(
      dispatch,
      extra.ideMessenger,
      activeTools,
      generatedCalls3,
      toolPolicies,
      selectAutoApproval(state3).active
        ? {
            sessionId: state3.session.id,
            history: buildReviewHistory(state3.session.history),
            onceGrants: state3.blockedCalls.grants,
            agent: mainAuditAgent(state3.session.id, state3.session.mode),
          }
        : undefined,
      selectApprovalSettings(state3),
      state3.session.mode,
      state3.session.id,
      mainAuditAgent(state3.session.id, state3.session.mode),
      buildReviewHistory(state3.session.history),
    );
    // Loop mode: a run past its turn limit that keeps calling tools ends here
    if (endRunAtTurnLimit(dispatch, getState)) {
      await dispatch(cancelStream({ loop: "keep" }));
      return;
    }
    // Loop mode holds calls that would ask instead of waiting (loopHolds.ts)
    const policies = applyLoopHolds(dispatch, getState, evaluated);
    // A hold can end the run (a call repeated after it was refused)
    if (getState().session.loop?.current?.report) {
      await dispatch(cancelStream({ loop: "keep" }));
      return;
    }
    const autoApprovedPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithoutPermission",
    );
    const needsApprovalPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    // 4. Execute remaining tool calls
    if (originalToolCalls.length === 0) {
      // A tool call written as text did nothing: tell the model once, then
      // let it answer in the same turn (H13)
      if (
        await nudgeLeakedToolCall({
          state: getState(),
          toolNames: activeTools.map((t) => t.function.name),
          dispatch,
          getState,
          ideMessenger: extra.ideMessenger,
        })
      ) {
        unwrapResult(await dispatch(streamNormalInput({ depth: depth + 1 })));
        return;
      }
      dispatch(setInactive());
      // A reply without tool calls ends the agent's turn: messages queued
      // while it worked can go now (waiting for approval is not an end)
      dispatch(requestQueuedMessagesSend());
    } else if (needsApprovalPolicies.length > 0) {
      // What needs no approval runs now; only the rest waits for the person
      if (autoApprovedPolicies.length > 0) {
        const state4 = getState();
        if (streamAborter.signal.aborted || !state4.session.isStreaming) {
          return;
        }
        await Promise.all(
          autoApprovedPolicies.map(async ({ toolCallState }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId: toolCallState.toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      }

      dispatch(setInactive());
    } else {
      // auto stream cases increase thunk depth by 1 for debugging
      const state4 = getState();
      const generatedCalls4 = selectPendingToolCalls(state4);
      if (streamAborter.signal.aborted || !state4.session.isStreaming) {
        return;
      }
      if (generatedCalls4.length > 0) {
        await Promise.all(
          generatedCalls4.map(async ({ toolCallId }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      } else {
        for (const { toolCallId } of originalToolCalls) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId,
                depth: depth + 1,
              }),
            ),
          );
        }
      }
    }
  },
);
