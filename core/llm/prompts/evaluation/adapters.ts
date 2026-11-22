import type { ChatMessage, ILLM, Tool, ToolCallDelta } from "../../..";

/**
 * Minimal chat adapters with tool calling, for running the evaluation against
 * a real model without loading a Continue config. One non-streaming request
 * at temperature 0; the tools are sent in the provider's own shape and the
 * calls come back as `toolCalls` on the assistant message.
 */
type Chat = Pick<ILLM, "chat">;

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/**
 * The provider's stop reason on a `usage` field, the way core's Bedrock class
 * reports it (`usage.response.stopReason`), so the runner reads one shape.
 */
function usageWithStop(usage: any, stopReason: unknown) {
  if (typeof stopReason !== "string" || !stopReason) return {};
  return { usage: { ...(usage ?? {}), response: { stopReason } } };
}

/** core's budget thresholds (budgetTokensToEffort): at most 1024 low, at most 4096 medium, else high. */
function effortWord(budget: number | undefined): "low" | "medium" | "high" {
  if (budget === undefined || budget <= 1024) return "low";
  return budget <= 4096 ? "medium" : "high";
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
      .join("");
  }
  return "";
}

/** OpenAI, and anything that speaks its /chat/completions with tools (Ollama, LM Studio, vLLM, ...). */
export function openAiCompatible(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Chat {
  return {
    chat: async (messages: ChatMessage[], signal, options) => {
      const body: any = {
        model: opts.model,
        messages: messages.map((m) => {
          if (m.role === "assistant") {
            const calls = (m.toolCalls ?? []).map((c) => ({
              id: c.id,
              type: "function",
              function: {
                name: c.function?.name,
                arguments: c.function?.arguments ?? "{}",
              },
            }));
            return {
              role: "assistant",
              content: textOf(m.content) || null,
              ...(calls.length ? { tool_calls: calls } : {}),
            };
          }
          if (m.role === "tool") {
            return {
              role: "tool",
              tool_call_id: m.toolCallId,
              content: m.content,
            };
          }
          return { role: m.role, content: textOf(m.content) };
        }),
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 4000,
      };
      // Reasoning on: the OpenAI-style effort word (gpt-5, local servers).
      if (options?.reasoning) {
        body.reasoning_effort = effortWord(options.reasoningBudgetTokens);
      }
      if (options?.tools?.length) {
        body.tools = options.tools.map((t: Tool) => ({
          type: "function",
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        }));
      }
      const data = await postJson(
        `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
        opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
        body,
        signal,
      );
      const choice = data.choices?.[0] ?? {};
      const message = choice.message ?? {};
      const toolCalls: ToolCallDelta[] = (message.tool_calls ?? []).map(
        (c: any) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.function?.name,
            arguments: c.function?.arguments ?? "{}",
          },
        }),
      );
      return {
        role: "assistant",
        content: message.content ?? "",
        ...(toolCalls.length ? { toolCalls } : {}),
        ...usageWithStop(data.usage, choice.finish_reason),
      };
    },
  };
}

export function anthropicMessages(opts: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): Chat {
  return {
    chat: async (messages: ChatMessage[], signal, options) => {
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => textOf(m.content))
        .join("\n");
      const converted: any[] = [];
      for (const m of messages) {
        if (m.role === "system") continue;
        if (m.role === "assistant") {
          const blocks: any[] = [];
          const text = textOf(m.content);
          if (text) blocks.push({ type: "text", text });
          for (const c of m.toolCalls ?? []) {
            let input: unknown = {};
            try {
              input = JSON.parse(c.function?.arguments || "{}");
            } catch {
              input = {};
            }
            blocks.push({
              type: "tool_use",
              id: c.id,
              name: c.function?.name,
              input,
            });
          }
          converted.push({ role: "assistant", content: blocks });
        } else if (m.role === "tool") {
          const block = {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          };
          const last = converted[converted.length - 1];
          // Results of parallel calls share one user message.
          if (
            last?.role === "user" &&
            Array.isArray(last.content) &&
            last.content[0]?.type === "tool_result"
          ) {
            last.content.push(block);
          } else {
            converted.push({ role: "user", content: [block] });
          }
        } else if (m.role === "user") {
          converted.push({ role: "user", content: textOf(m.content) });
        }
      }
      const body: any = {
        model: opts.model,
        system,
        messages: converted,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 4000,
      };
      // Reasoning on: extended thinking with the budget; temperature must be
      // left alone and the budget must fit under max_tokens.
      if (options?.reasoning) {
        const budget = options.reasoningBudgetTokens ?? 1024;
        body.thinking = { type: "enabled", budget_tokens: budget };
        body.max_tokens = Math.max(body.max_tokens, budget + 1000);
        delete body.temperature;
      }
      if (options?.tools?.length) {
        body.tools = options.tools.map((t: Tool) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters ?? { type: "object" },
        }));
      }
      const data = await postJson(
        `${(opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body,
        signal,
      );
      const parts: any[] = data.content ?? [];
      const toolCalls: ToolCallDelta[] = parts
        .filter((p) => p.type === "tool_use")
        .map((p) => ({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        }));
      return {
        role: "assistant",
        content: parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...usageWithStop(data.usage, data.stop_reason),
      };
    },
  };
}

/**
 * Amazon Bedrock through core's own provider class, so the request is built
 * the way the IDE builds it (Converse tool config, Nova and Claude field
 * differences, cross-region inference). Credentials come from the AWS chain,
 * with `profile` naming an entry in ~/.aws/config. The streaming path is used
 * because `BaseLLM.chat` renders tool calls to text.
 */
export function bedrockConverse(opts: {
  model: string;
  region: string;
  profile?: string;
}): Chat {
  let client: Promise<any> | undefined;
  const load = () =>
    (client ??= import("../../llms/Bedrock").then(
      (m) =>
        new m.default({
          model: opts.model,
          region: opts.region,
          ...(opts.profile ? { profile: opts.profile } : {}),
          crossRegionInference: "auto",
        } as any),
    ));
  return {
    chat: async (messages: ChatMessage[], signal, options) => {
      const llm = await load();
      let content = "";
      let usage: any;
      const toolCalls: ToolCallDelta[] = [];
      for await (const chunk of llm.streamChat(messages, signal, {
        tools: options?.tools,
        temperature: options?.temperature ?? 0,
        maxTokens: options?.maxTokens ?? 4000,
        // Core turns these into the family's own switch (bedrockReasoningFields).
        ...(options?.reasoning
          ? {
              reasoning: true,
              reasoningBudgetTokens: options.reasoningBudgetTokens,
            }
          : {}),
      })) {
        if (chunk.role !== "assistant") continue;
        // The Bedrock class puts the stop reason on the usage chunk.
        if (chunk.usage) usage = chunk.usage;
        content += textOf(chunk.content);
        for (const delta of chunk.toolCalls ?? []) {
          // A block start carries the id and name; later fragments of the
          // same call carry only more of the arguments.
          const existing = delta.id
            ? toolCalls.find((c) => c.id === delta.id)
            : toolCalls[toolCalls.length - 1];
          if (existing) {
            existing.function!.arguments =
              (existing.function!.arguments ?? "") +
              (delta.function?.arguments ?? "");
            if (delta.function?.name && !existing.function!.name) {
              existing.function!.name = delta.function.name;
            }
          } else {
            toolCalls.push({
              id: delta.id,
              type: "function",
              function: {
                name: delta.function?.name,
                arguments: delta.function?.arguments ?? "",
              },
            });
          }
        }
      }
      return {
        role: "assistant",
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(usage ? { usage } : {}),
      };
    },
  };
}

/**
 * The model the TURNS_EVAL_* variables name (see live.vitest.ts), with its
 * label for a report. Every suite in this directory picks its model here, so
 * they all go through the same provider path.
 */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): {
  label: string;
  model: Chat;
} {
  const id = env.TURNS_EVAL_MODEL ?? "";
  const provider = env.TURNS_EVAL_PROVIDER ?? "openai";
  const apiKey = env.TURNS_EVAL_API_KEY ?? "";
  return {
    label: `${provider}:${id}`,
    model:
      provider === "bedrock"
        ? bedrockConverse({
            model: id,
            region: env.TURNS_EVAL_REGION ?? "us-east-1",
            profile: env.TURNS_EVAL_AWS_PROFILE,
          })
        : provider === "anthropic"
          ? anthropicMessages({
              model: id,
              apiKey,
              baseUrl: env.TURNS_EVAL_BASE_URL,
            })
          : openAiCompatible({
              model: id,
              apiKey: apiKey || undefined,
              baseUrl: env.TURNS_EVAL_BASE_URL ?? "https://api.openai.com/v1",
            }),
  };
}
