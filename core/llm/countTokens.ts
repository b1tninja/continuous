import { Tiktoken, encodingForModel as _encodingForModel } from "js-tiktoken";

import {
  ChatMessage,
  CompiledMessagesResult,
  MessageContent,
  MessagePart,
  Tool,
} from "../index.js";
import { autodetectTemplateType } from "./autodetect.js";
import {
  addSpaceToAnyEmptyMessages,
  isUserOrToolMsg,
  messageHasToolCallId,
} from "./messages.js";
import { normalizeTurns, type TurnRepair } from "./normalizeTurns.js";

import { renderChatMessage } from "../util/messageContent.js";
import { isSummaryMessage } from "../util/summaryMessage.js";
import { isTaskPlanBlockText } from "../util/taskPlan.js";
import { AsyncEncoder, LlamaAsyncEncoder } from "./asyncEncoder.js";
import { ageRequest, type AgeingState } from "../util/contextAgeing.js";
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_PRUNING_LENGTH } from "./constants.js";
import {
  blocksToDrop,
  type ContextClass,
  contextLimits,
  countingSafetyBuffer,
  MIN_RESPONSE_TOKENS,
} from "./contextThresholds.js";
import { getAdjustedTokenCountFromModel } from "./getAdjustedTokenCount.js";
import llamaTokenizer from "./llamaTokenizer.js";
interface Encoding {
  encode: Tiktoken["encode"];
  decode: Tiktoken["decode"];
}

class LlamaEncoding implements Encoding {
  encode(text: string): number[] {
    return llamaTokenizer.encode(text);
  }

  decode(tokens: number[]): string {
    return llamaTokenizer.decode(tokens);
  }
}

class NonWorkerAsyncEncoder implements AsyncEncoder {
  constructor(private readonly encoding: Encoding) {}

  async close(): Promise<void> {}

  async encode(text: string): Promise<number[]> {
    return this.encoding.encode(text);
  }

  async decode(tokens: number[]): Promise<string> {
    return this.encoding.decode(tokens);
  }
}

let gptEncoding: Encoding | null = null;
const llamaEncoding = new LlamaEncoding();
const llamaAsyncEncoder = new LlamaAsyncEncoder();

function asyncEncoderForModel(modelName: string): AsyncEncoder {
  // Temporary due to issues packaging the worker files
  if (process.env.IS_BINARY) {
    const encoding = encodingForModel(modelName);
    return new NonWorkerAsyncEncoder(encoding);
  }

  const modelType = autodetectTemplateType(modelName);
  if (!modelType || modelType === "none") {
    // Right now there is a problem packaging js-tiktoken in workers. Until then falling back
    // Cannot find package 'js-tiktoken' imported from /Users/nate/gh/continuedev/continue/extensions/vscode/out/tiktokenWorkerPool.mjs
    // return gptAsyncEncoder;
    return llamaAsyncEncoder;
  }
  return llamaAsyncEncoder;
}

function encodingForModel(modelName: string): Encoding {
  const modelType = autodetectTemplateType(modelName);

  if (!modelType || modelType === "none") {
    if (!gptEncoding) {
      gptEncoding = _encodingForModel("gpt-4");
    }

    return gptEncoding;
  }

  return llamaEncoding;
}

function countImageTokens(content: MessagePart): number {
  if (content.type === "imageUrl") {
    return 1024;
  }
  throw new Error("Non-image content type");
}

async function countTokensAsync(
  content: MessageContent,
  // defaults to llama2 because the tokenizer tends to produce more tokens
  modelName = "llama2",
): Promise<number> {
  const encoding = asyncEncoderForModel(modelName);
  if (Array.isArray(content)) {
    const promises = content.map(async (part) => {
      if (part.type === "imageUrl") {
        return countImageTokens(part);
      }
      return (await encoding.encode(part.text ?? "")).length;
    });
    return (await Promise.all(promises)).reduce((sum, val) => sum + val, 0);
  }
  return (await encoding.encode(content ?? "")).length;
}

function countTokens(
  content: MessageContent,
  // defaults to llama2 because the tokenizer tends to produce more tokens
  modelName = "llama2",
): number {
  const encoding = encodingForModel(modelName);
  let baseTokens = 0;
  if (Array.isArray(content)) {
    baseTokens = content.reduce((acc, part) => {
      return (
        acc +
        (part.type === "text"
          ? encoding.encode(part.text ?? "", "all", []).length
          : countImageTokens(part))
      );
    }, 0);
  } else {
    baseTokens = encoding.encode(content ?? "", "all", []).length;
  }
  return getAdjustedTokenCountFromModel(baseTokens, modelName);
}

// https://community.openai.com/t/how-to-calculate-the-tokens-when-using-function-call/266573/10
function countToolsTokens(tools: Tool[], modelName: string): number {
  const count = (value: string) =>
    encodingForModel(modelName).encode(value).length;

  let numTokens = 12;

  for (const tool of tools) {
    let functionTokens = count(tool.function.name);
    if (tool.function.description) {
      functionTokens += count(tool.function.description);
    }
    const props = tool.function.parameters?.properties;
    if (props) {
      for (const key in props) {
        functionTokens += count(key);
        const fields = props[key];
        if (fields) {
          const fieldType = fields["type"];
          const fieldDesc = fields["description"];
          const fieldEnum = fields["enum"];
          if (fieldType && typeof fieldType === "string") {
            functionTokens += 2;
            functionTokens += count(fieldType);
          }
          if (fieldDesc && typeof fieldDesc === "string") {
            functionTokens += 2;
            functionTokens += count(fieldDesc);
          }
          if (fieldEnum && Array.isArray(fieldEnum)) {
            functionTokens -= 3;
            for (const e of fieldEnum) {
              functionTokens += 3;
              functionTokens += typeof e === "string" ? count(e) : 5;
            }
          }
        }
      }
    }
    numTokens += functionTokens;
  }

  return numTokens + 12;
}

function countChatMessageTokens(
  modelName: string,
  chatMessage: ChatMessage,
): number {
  // Doing simpler, safer version of what is here:
  // https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
  // every message follows <|im_start|>{role/name}\n{content}<|end|>\n
  const BASE_TOKENS = 4;
  const TOOL_CALL_EXTRA_TOKENS = 10;
  const TOOL_OUTPUT_EXTRA_TOKENS = 10;
  let tokens = BASE_TOKENS;

  if (chatMessage.content) {
    tokens += countTokens(chatMessage.content, modelName);
  }

  if ("toolCalls" in chatMessage && chatMessage.toolCalls) {
    for (const call of chatMessage.toolCalls) {
      tokens += TOOL_CALL_EXTRA_TOKENS;
      tokens += countTokens(JSON.stringify(call), modelName); // TODO hone this
    }
  }

  if (chatMessage.role === "thinking") {
    if (chatMessage.redactedThinking) {
      tokens += countTokens(chatMessage.redactedThinking, modelName);
    }
    if (chatMessage.signature) {
      tokens += countTokens(chatMessage.signature, modelName);
    }
  }

  if (chatMessage.role === "tool") {
    tokens += TOOL_OUTPUT_EXTRA_TOKENS; // safety
    if (chatMessage.toolCallId) {
      tokens += countTokens(chatMessage.toolCallId, modelName);
    }
  }
  return tokens;
}

/**
 * Our estimate of a request's prompt, counted as `compileChatMessages`
 * counts it: every message, plus the tool definitions. The calibration from
 * usage (contextOverflow.ts) compares the provider's count with this.
 */
function estimatePromptTokens(
  modelName: string,
  messages: ChatMessage[],
  tools?: Tool[],
): number {
  let total = tools ? countToolsTokens(tools, modelName) : 0;
  for (const message of messages) {
    total += countChatMessageTokens(modelName, message);
  }
  return total;
}

/**
 * Extracts and validates the tool call sequence from the end of a message array.
 * Tool sequences consist of: [assistant_with_tool_calls, tool_response_1, tool_response_2, ...]
 * or just a single user message.
 *
 * @param messages - Array of chat messages (will be modified by popping messages)
 * @returns Array of messages that form the tool sequence
 */
function extractToolSequence(messages: ChatMessage[]): ChatMessage[] {
  const lastMsg = messages.pop();
  if (!lastMsg) {
    throw new Error("Error parsing chat history: no user/tool message found");
  }

  const toolSequence: ChatMessage[] = [];

  if (lastMsg.role === "tool") {
    toolSequence.push(lastMsg);

    // Collect all consecutive tool messages from the end
    while (
      messages.length > 0 &&
      messages[messages.length - 1].role === "tool"
    ) {
      toolSequence.unshift(messages.pop()!);
    }

    // Get the assistant message with tool calls
    const assistantMsg = messages.pop();
    if (assistantMsg) {
      toolSequence.unshift(assistantMsg);

      // Validate that all tool messages have matching tool call IDs
      for (const toolMsg of toolSequence.slice(1)) {
        // Skip assistant message
        if (
          toolMsg.role === "tool" &&
          !messageHasToolCallId(assistantMsg, toolMsg.toolCallId)
        ) {
          throw new Error(
            `Error parsing chat history: no tool call found to match tool output for id "${toolMsg.toolCallId}"`,
          );
        }
      }
    }
  } else if (lastMsg.role === "assistant" || lastMsg.role === "thinking") {
    toolSequence.push(lastMsg);
    while (
      messages.length > 0 &&
      (messages[messages.length - 1].role === "thinking" ||
        messages[messages.length - 1].role === "assistant")
    ) {
      toolSequence.unshift(messages.pop()!);
    }
  } else {
    // Single user message
    toolSequence.push(lastMsg);
  }

  return toolSequence;
}

function pruneLinesFromTop(
  prompt: string,
  maxTokens: number,
  modelName: string,
): string {
  const lines = prompt.split("\n");
  // Preprocess tokens for all lines and cache them.
  const lineTokens = lines.map((line) => countTokens(line, modelName));
  let totalTokens = lineTokens.reduce((sum, tokens) => sum + tokens, 0);
  let start = 0;
  let currentLines = lines.length;

  // Calculate initial token count including newlines
  totalTokens += Math.max(0, currentLines - 1); // Add tokens for joining newlines

  // Using indexes instead of array modifications.
  // Remove lines from the top until the token count is within the limit.
  while (totalTokens > maxTokens && start < currentLines) {
    totalTokens -= lineTokens[start];
    // Decrement token count for the removed line and its preceding/joining newline (if not the last line)
    if (currentLines - start > 1) {
      totalTokens--;
    }
    start++;
  }

  return lines.slice(start).join("\n");
}

function pruneLinesFromBottom(
  prompt: string,
  maxTokens: number,
  modelName: string,
): string {
  const lines = prompt.split("\n");
  const lineTokens = lines.map((line) => countTokens(line, modelName));
  let totalTokens = lineTokens.reduce((sum, tokens) => sum + tokens, 0);
  let end = lines.length;

  // Calculate initial token count including newlines
  totalTokens += Math.max(0, end - 1); // Add tokens for joining newlines

  // Reverse traversal to avoid array modification
  // Remove lines from the bottom until the token count is within the limit.
  while (totalTokens > maxTokens && end > 0) {
    end--;
    totalTokens -= lineTokens[end];
    // Decrement token count for the removed line and its following/joining newline (if not the first line)
    if (end > 0) {
      totalTokens--;
    }
  }

  return lines.slice(0, end).join("\n");
}

function pruneStringFromBottom(
  modelName: string,
  maxTokens: number,
  prompt: string,
): string {
  const encoding = encodingForModel(modelName);

  const tokens = encoding.encode(prompt, "all", []);
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  return encoding.decode(tokens.slice(0, maxTokens));
}

function pruneStringFromTop(
  modelName: string,
  maxTokens: number,
  prompt: string,
): string {
  const encoding = encodingForModel(modelName);

  const tokens = encoding.encode(prompt, "all", []);
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  return encoding.decode(tokens.slice(tokens.length - maxTokens));
}

export function getTokenCountingBufferSafety(contextLength: number) {
  return countingSafetyBuffer(contextLength);
}

function pruneRawPromptFromTop(
  modelName: string,
  contextLength: number,
  prompt: string,
  tokensForCompletion: number,
): string {
  const maxTokens =
    contextLength -
    tokensForCompletion -
    getTokenCountingBufferSafety(contextLength);
  return pruneStringFromTop(modelName, maxTokens, prompt);
}

/**
 * The history without every message that starts within the first
 * `dropTokens` tokens of it, counted from the start. A tool result goes with
 * its call, so no result is left without the call that produced it, and
 * `keep` (the user's last message in a tool loop) is never dropped and takes
 * no room in the count. So does the compaction summary, which belongs to the
 * head.
 */
function dropOldestBlocks<T extends ChatMessage & { tokens: number }>(
  history: T[],
  dropTokens: number,
  keep: ReadonlySet<T>,
): T[] {
  if (dropTokens <= 0) return history;
  const kept: T[] = [];
  let position = 0;
  let callDropped = false;
  for (const message of history) {
    if (keep.has(message)) {
      kept.push(message);
      continue;
    }
    const start = position;
    position += message.tokens;
    const drop: boolean =
      message.role === "tool" ? callDropped : start < dropTokens;
    if (message.role !== "tool") callDropped = drop;
    if (!drop) kept.push(message);
  }
  return kept;
}

/**
 * Reconciles chat messages with available context length by intelligently pruning older messages
 * while preserving critical conversation elements.
 *
 * Core Guidelines:
 * - Always preserve the last user/tool message sequence (including any associated assistant message with tool calls)
 * - Always preserve the system message and tools
 * - Never allow orphaned tool responses without their corresponding tool calls
 * - Remove older messages first when pruning is necessary
 * - Maintain conversation coherence by flattening adjacent similar messages
 *
 * Process:
 * 1. Handle image content conversion for models that don't support images
 * 2. Extract and preserve system message
 * 3. Filter out empty messages and trailing non-user/tool messages
 * 4. Extract the complete tool sequence from the end (user message or assistant + tool responses)
 * 5. Calculate token requirements for non-negotiable elements (system, tools, last sequence)
 * 6. Past the force threshold, drop the oldest history in whole blocks
 *    (contextThresholds.ts), so the cut moves once per block, never back
 * 7. Reassemble with proper ordering and flatten adjacent similar messages
 *
 * @param params - Configuration object containing:
 *   - modelName: LLM model name for token counting
 *   - msgs: Array of chat messages to process
 *   - contextLength: Maximum context length supported by the model
 *   - maxTokens: Maximum tokens to reserve for the response
 *   - supportsImages: Whether the model supports image content
 *   - tools: Optional array of available tools
 * @returns Processed array of chat messages that fit within context constraints
 * @throws Error if non-negotiable elements exceed available context
 */
/**
 * Said when the prompt cannot be made to fit. Starts with "Not enough context"
 * so the chat UI can tell this from other compile failures, then the sizes
 * and where the window is changed.
 */
function contextWindowError(p: {
  window: number;
  promptTokens: number;
  systemMsgTokens: number;
  toolTokens: number;
  lastMessagesTokens: number;
  reservedOutputTokens: number;
  countingSafetyBuffer: number;
  unknown: boolean;
}): string {
  const standIn = p.unknown
    ? ` No published window is known for this model, so ${DEFAULT_CONTEXT_LENGTH} is in use until you set one.`
    : "";
  return (
    `Not enough context. This prompt does not fit the model's context window. ` +
    `The prompt is about ${p.promptTokens} tokens and the window is ${p.window} tokens ` +
    `(system message ~${p.systemMsgTokens}, tools ~${p.toolTokens}, the latest turn ~${p.lastMessagesTokens}; ` +
    `${p.reservedOutputTokens} kept for the reply, ${p.countingSafetyBuffer} held back for counting error). ` +
    `Change the context length in Models → Configure → Context & cost.` +
    standIn
  );
}

function compileChatMessages({
  modelName,
  msgs,
  knownContextLength,
  contextLengthUnknown = false,
  maxTokens,
  supportsImages,
  tools,
  ageing,
  requiresAlternation,
  contextClass = "cloud",
}: {
  modelName: string;
  msgs: ChatMessage[];
  knownContextLength: number | undefined;
  /** The window is the 32,768 stand-in, not a published or configured limit. */
  contextLengthUnknown?: boolean;
  maxTokens: number;
  supportsImages: boolean;
  tools?: Tool[];
  /**
   * History ageing (util/contextAgeing.ts). Left out, the request is built
   * exactly as before. The caller keeps `state` between requests.
   */
  ageing?: { state: AgeingState; now?: number };
  /** The provider wants turns to alternate (normalizeTurns.ts). */
  requiresAlternation?: boolean;
  /** Which thresholds of contextThresholds.ts apply; cloud when left out. */
  contextClass?: ContextClass;
}): CompiledMessagesResult {
  let didPrune = false;
  const repairs: TurnRepair[] = [];
  let didAge = false;

  let msgsCopy: ChatMessage[] = msgs.map((m) => ({ ...m }));

  // If images not supported, convert MessagePart[] to string
  if (!supportsImages) {
    for (const msg of msgsCopy) {
      if ("content" in msg && Array.isArray(msg.content)) {
        const content = renderChatMessage(msg);
        msg.content = content;
      }
    }
  }

  // Extract system message
  const systemMsg = msgsCopy.find((msg) => msg.role === "system");
  msgsCopy = msgsCopy.filter((msg) => msg.role !== "system");

  // Make the history one every provider accepts: empty turns and orphan
  // reasoning dropped, every tool call answered and every result paired
  // (normalizeTurns.ts). A valid history comes back unchanged.
  const normalized = normalizeTurns(msgsCopy, { requiresAlternation });
  msgsCopy = normalized.messages;
  repairs.push(...normalized.repairs);

  msgsCopy = addSpaceToAnyEmptyMessages(msgsCopy);

  // The task list block (util/taskPlan.ts) rides at the very end. Set it
  // aside so the real last turn is still the protected tail, and count it as
  // non-negotiable: it is put back last.
  const last = msgsCopy[msgsCopy.length - 1];
  const taskListTail =
    msgsCopy.length > 1 &&
    last?.role === "user" &&
    typeof last.content === "string" &&
    isTaskPlanBlockText(last.content)
      ? msgsCopy.pop()
      : undefined;

  // Mask old tool results (off unless the caller passes `ageing`). Done before
  // pruning, so what is counted and pruned is what would be sent.
  if (ageing) {
    const available =
      (knownContextLength ?? DEFAULT_PRUNING_LENGTH) -
      getTokenCountingBufferSafety(
        knownContextLength ?? DEFAULT_PRUNING_LENGTH,
      ) -
      Math.min(MIN_RESPONSE_TOKENS, maxTokens);
    const aged = ageRequest(msgsCopy, {
      state: ageing.state,
      availableTokens: available,
      now: ageing.now,
    });
    msgsCopy = aged.messages;
    didAge = aged.didAge;
  }

  // Extract the tool sequence from the end of the message array
  const toolSequence = extractToolSequence(msgsCopy);

  // Count tokens for all messages in the tool sequence
  let lastMessagesTokens = taskListTail
    ? countChatMessageTokens(modelName, taskListTail)
    : 0;
  for (const msg of toolSequence) {
    lastMessagesTokens += countChatMessageTokens(modelName, msg);
  }

  // System message
  let systemMsgTokens = 0;
  if (systemMsg) {
    systemMsgTokens = countChatMessageTokens(modelName, systemMsg);
  }

  // Tools
  let toolTokens = 0;
  if (tools) {
    toolTokens = countToolsTokens(tools, modelName);
  }

  const contextLength = knownContextLength ?? DEFAULT_PRUNING_LENGTH;
  const limits = contextLimits(contextLength, maxTokens, contextClass);
  const countingSafetyBuffer = limits.safety;
  // The preferred reserve is 10% of the window. A latest turn that does not
  // fit beside it is still sent when it fits beside the minimum reply: the
  // reserve shrinks, and the request's maxTokens shrinks with it
  // (requestBudget.ts). Refusing here is what stopped the agent after one
  // large tool result on a window that still had room.
  const minimumReserve = Math.min(MIN_RESPONSE_TOKENS, Math.max(0, maxTokens));
  const protectedTokens = toolTokens + systemMsgTokens + lastMessagesTokens;
  const roomFor = (promptTokens: number, reserve: number) =>
    contextLength - countingSafetyBuffer - reserve - promptTokens;

  if (
    knownContextLength !== undefined &&
    roomFor(protectedTokens, minimumReserve) < 0
  ) {
    throw new Error(
      contextWindowError({
        window: knownContextLength,
        promptTokens: protectedTokens,
        systemMsgTokens,
        toolTokens,
        lastMessagesTokens,
        reservedOutputTokens: minimumReserve,
        countingSafetyBuffer,
        unknown: contextLengthUnknown,
      }),
    );
  }

  let reservedOutputTokens = limits.reserve;
  if (roomFor(protectedTokens, reservedOutputTokens) < 0) {
    reservedOutputTokens = Math.max(
      minimumReserve,
      contextLength - countingSafetyBuffer - protectedTokens,
    );
  }

  // Now remove messages till we're under the limit
  let currentTotal = 0;
  const historyWithTokens = msgsCopy.map((message) => {
    const tokens = countChatMessageTokens(modelName, message);
    currentTotal += tokens;
    return {
      ...message,
      tokens,
    };
  });

  // In a tool loop the trailing sequence is assistant tool calls and their
  // results, so the user's last message is in the prunable history. Never
  // drop it: some providers reject a request with no user message (Ollama
  // answers 500). Once everything before it is gone, the older tool rounds
  // after it are dropped instead.
  const protectedUser = toolSequence.some((m) => m.role === "user")
    ? undefined
    : // A reverse search, not findLast: gui/vscode/binary compile core with ES2022 libs.
      [...historyWithTokens].reverse().find((m) => m.role === "user");

  // Drop in whole blocks (contextThresholds.ts). The history is pruned from
  // scratch on every request, so the cut must be a function of the
  // conversation that only moves forward as it grows: every message before
  // `blocks` blocks of history, counted from the start, is dropped. That
  // count depends on the total only through the block number, so the size of
  // the latest turn cannot move the cut by a message either way.
  const blocks = blocksToDrop(
    currentTotal + systemMsgTokens + toolTokens + lastMessagesTokens,
    limits,
  );
  // The compaction summary (util/summaryMessage.ts) is the first message
  // after the system message. It is part of the head: never dropped, and the
  // blocks are counted from the turns after it.
  const summary = isSummaryMessage(historyWithTokens[0])
    ? historyWithTokens[0]
    : undefined;
  const kept = dropOldestBlocks(
    historyWithTokens,
    blocks * limits.block,
    new Set([protectedUser, summary].filter((m) => m !== undefined)),
  );
  if (kept.length < historyWithTokens.length) {
    didPrune = true;
    currentTotal = kept.reduce((sum, m) => sum + m.tokens, 0);
  }

  // Now reassemble. Pruning can strand a tool call whose results it removed,
  // or leave the history starting with the model, so normalise again.
  const conversation = normalizeTurns(
    [
      ...kept.map(({ tokens, ...rest }) => rest),
      ...toolSequence,
      ...(taskListTail ? [taskListTail] : []),
    ],
    { requiresAlternation },
  );
  repairs.push(...conversation.repairs);
  const reassembled: ChatMessage[] = [];
  if (systemMsg) {
    reassembled.push(systemMsg);
  }
  reassembled.push(...conversation.messages);

  const inputTokens =
    currentTotal + systemMsgTokens + toolTokens + lastMessagesTokens;
  // History that cannot be dropped (the latest user turn, the system message,
  // the tools) can still be larger than the window. Say so, with the sizes,
  // instead of sending a prompt the model will refuse with no explanation.
  if (
    knownContextLength !== undefined &&
    roomFor(inputTokens, minimumReserve) < 0
  ) {
    throw new Error(
      contextWindowError({
        window: knownContextLength,
        promptTokens: inputTokens,
        systemMsgTokens,
        toolTokens,
        lastMessagesTokens,
        reservedOutputTokens: minimumReserve,
        countingSafetyBuffer,
        unknown: contextLengthUnknown,
      }),
    );
  }
  const availableTokens =
    contextLength - countingSafetyBuffer - reservedOutputTokens;
  const contextPercentage = inputTokens / availableTokens;
  return {
    compiledChatMessages: reassembled,
    didPrune,
    ...(didAge && { didAge: true }),
    ...(repairs.length > 0 && { repairs }),
    contextPercentage,
    outputTokensAvailable: Math.max(
      0,
      contextLength - countingSafetyBuffer - inputTokens,
    ),
  };
}

async function cleanupAsyncEncoders(): Promise<void> {
  try {
    await llamaAsyncEncoder.close();
  } catch (e) {}
}

export {
  cleanupAsyncEncoders,
  compileChatMessages,
  countTokens,
  countTokensAsync,
  estimatePromptTokens,
  extractToolSequence,
  pruneLinesFromBottom,
  pruneLinesFromTop,
  pruneRawPromptFromTop,
  pruneStringFromBottom,
  pruneStringFromTop,
};
