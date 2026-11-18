/**
 * Converts OpenAI ChatCompletionMessageParam format to Vercel AI SDK CoreMessage format
 */

import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/index.js";

export interface VercelCoreMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<any>;
}

/**
 * A tool call's `input` must be an object. Arguments that are empty, cut off
 * by a stop, or not an object are sent as `{}` rather than as the raw string.
 */
function toolCallInput(args: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return {};
}

/** An assistant's content as AI SDK text parts (not one text holding the array). */
function assistantTextParts(
  content: ChatCompletionAssistantMessageParam["content"],
): Array<{ type: "text"; text: string }> {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content
    .map((part) => (part.type === "text" ? part.text : part.refusal))
    .filter((text) => !!text)
    .map((text) => ({ type: "text" as const, text }));
}

/** A user content part as an AI SDK part: an `image_url` becomes an image part. */
function toVercelUserPart(part: ChatCompletionContentPart): unknown {
  if (part.type === "image_url") {
    return { type: "image", image: part.image_url.url };
  }
  return part;
}

/**
 * Converts OpenAI messages to Vercel AI SDK CoreMessage format.
 *
 * Key differences:
 * - OpenAI tool calls: { role: "assistant", tool_calls: [{ id, function: { name, arguments } }] }
 * - Vercel tool calls: { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] }
 * - OpenAI tool results: { role: "tool", tool_call_id: "...", content: "string" }
 * - Vercel tool results: { role: "tool", content: [{ type: "tool-result", toolCallId: "...", toolName: "...", result: any }] }
 *
 * IMPORTANT: For multi-turn conversations with tools:
 * - We include assistant messages with tool_calls converted to Vercel format
 */
export function convertOpenAIMessagesToVercel(
  messages: ChatCompletionMessageParam[],
): VercelCoreMessage[] {
  const vercelMessages: VercelCoreMessage[] = [];

  // Build a map of tool_call_id => toolName from assistant messages
  const toolCallMap = new Map<string, string>();

  // First pass: collect tool call names
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function") {
          toolCallMap.set(tc.id, tc.function.name);
        }
      }
    }
  }

  // Second pass: convert messages
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        vercelMessages.push({
          role: "system",
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
        });
        break;

      case "user":
        vercelMessages.push({
          role: "user",
          content:
            typeof msg.content === "string"
              ? msg.content
              : msg.content.map(toVercelUserPart),
        });
        break;

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const contentParts: any[] = [];

          contentParts.push(...assistantTextParts(msg.content));

          for (const tc of msg.tool_calls) {
            if (tc.type === "function") {
              const input = toolCallInput(tc.function.arguments);

              const thoughtSignature = (tc as any)?.extra_content?.google
                ?.thought_signature as string | undefined;

              contentParts.push({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.function.name,
                input,
                ...(thoughtSignature && {
                  providerOptions: {
                    google: {
                      thoughtSignature,
                    },
                  },
                }),
              });
            }
          }

          vercelMessages.push({
            role: "assistant",
            content: contentParts,
          });
        } else {
          vercelMessages.push({
            role: "assistant",
            content: Array.isArray(msg.content)
              ? assistantTextParts(msg.content)
              : msg.content || "",
          });
        }
        break;

      case "tool":
        // Convert OpenAI tool result to Vercel format
        const toolName = toolCallMap.get(msg.tool_call_id) || "unknown_tool";
        vercelMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.tool_call_id,
              toolName,
              output: {
                type: "text",
                value:
                  typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
              },
            },
          ],
        });
        break;
    }
  }

  return vercelMessages;
}
