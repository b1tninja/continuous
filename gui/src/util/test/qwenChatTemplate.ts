/**
 * Test-only: the chat template the owner's Strata server serves for
 * `qwen3.8-flash-next-nvfp4-uncensored` (`/props` `chat_template`, read
 * 2026-11-15), written out in TypeScript. It renders an OpenAI chat body as
 * the server does, so a test can compare the token text two requests share,
 * not only their message arrays. What the reproduction relies on:
 *
 * - The tools come first, inside the system block, then the system message.
 * - `reasoning_effort` changes the first line of the system block.
 * - Every assistant message carries a `<think>` block (empty when no
 *   `reasoning_content` is sent) while `preserve_thinking` is unset or true;
 *   with it false, only the assistant messages after the last real user
 *   message do.
 * - Consecutive tool results share one user block.
 *
 * Images and videos are rendered as their placeholder, as the template does.
 */

interface WireMessage {
  role: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: {
    function?: { name: string; arguments?: string | Record<string, unknown> };
  }[];
}

export interface WireBody {
  messages: WireMessage[];
  tools?: unknown[];
  reasoning_effort?: string;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
    preserve_thinking?: boolean;
  };
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (item?.type === "image_url" || item?.image_url || item?.image) {
          return "<|vision_start|><|image_pad|><|vision_end|>";
        }
        if (typeof item?.text === "string") return item.text;
        throw new Error("Unexpected item type in content.");
      })
      .join("");
  }
  if (content === undefined || content === null) return "";
  throw new Error("Unexpected content type.");
}

/** Python's `tojson` as Jinja applies it: compact separators with a space. */
function toJson(value: unknown): string {
  return JSON.stringify(value).replace(/":/g, '": ').replace(/,"/g, ', "');
}

const TOOL_FORMAT =
  "\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>";

function reasoningInstructions(body: WireBody): string {
  const enable = body.chat_template_kwargs?.enable_thinking;
  if (enable === false) return "";
  const effort = body.reasoning_effort ?? "xhigh";
  if (effort === "xhigh") {
    return "Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.";
  }
  if (effort === "low") {
    return "Reasoning effort is set to low. Keep your thinking brief and focused, moving directly to the conclusion without unnecessary elaboration.";
  }
  if (effort === "medium") return "";
  throw new Error(`Unexpected reasoning effort ${effort}.`);
}

/** The prompt text the server reads for `body`, generation prompt included. */
export function renderQwenPrompt(body: WireBody): string {
  const { messages } = body;
  if (!messages.length) throw new Error("No messages provided.");
  const out: string[] = [];
  const instructions = reasoningInstructions(body);
  const first = messages[0];
  const systemText =
    first.role === "system" ? renderContent(first.content).trim() : "";
  if (body.tools?.length) {
    out.push("<|im_start|>system\n");
    if (instructions) out.push(`${instructions}\n\n`);
    out.push(
      "# Tools\n\nYou have access to the following functions:\n\n<tools>",
    );
    for (const tool of body.tools) out.push(`\n${toJson(tool)}`);
    out.push("\n</tools>", TOOL_FORMAT);
    if (systemText) out.push(`\n\n${systemText}`);
    out.push("<|im_end|>\n");
  } else if (systemText) {
    out.push(
      `<|im_start|>system\n${instructions ? `${instructions}\n\n` : ""}${systemText}<|im_end|>\n`,
    );
  } else if (instructions) {
    out.push(`<|im_start|>system\n${instructions}<|im_end|>\n`);
  }

  let lastQuery = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = renderContent(messages[i].content).trim();
    if (!(
      text.startsWith("<tool_response>") && text.endsWith("</tool_response>")
    )) {
      lastQuery = i;
      break;
    }
  }
  if (lastQuery < 0) throw new Error("No user query found in messages.");
  const preserve = body.chat_template_kwargs?.preserve_thinking;

  messages.forEach((message, i) => {
    const content = renderContent(message.content).trim();
    if (message.role === "system") {
      if (i !== 0) throw new Error("System message must be at the beginning.");
    } else if (message.role === "user") {
      out.push(`<|im_start|>user\n${content}<|im_end|>\n`);
    } else if (message.role === "assistant") {
      const reasoning =
        typeof message.reasoning_content === "string"
          ? message.reasoning_content.trim()
          : "";
      if (preserve === undefined || preserve === true || i > lastQuery) {
        out.push(
          `<|im_start|>assistant\n<think>\n${reasoning}\n</think>\n\n${content}`,
        );
      } else {
        out.push(`<|im_start|>assistant\n${content}`);
      }
      (message.tool_calls ?? []).forEach((call, n) => {
        const fn = call.function ?? (call as any);
        if (n === 0) {
          out.push(
            content.trim()
              ? `\n\n<tool_call>\n<function=${fn.name}>\n`
              : `<tool_call>\n<function=${fn.name}>\n`,
          );
        } else {
          out.push(`\n<tool_call>\n<function=${fn.name}>\n`);
        }
        const args =
          typeof fn.arguments === "string"
            ? fn.arguments
              ? JSON.parse(fn.arguments)
              : {}
            : (fn.arguments ?? {});
        for (const [name, value] of Object.entries(args)) {
          out.push(
            `<parameter=${name}>\n${typeof value === "string" ? value : toJson(value)}\n</parameter>\n`,
          );
        }
        out.push("</function>\n</tool_call>");
      });
      out.push("<|im_end|>\n");
    } else if (message.role === "tool") {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      if (prev && prev.role !== "tool") out.push("<|im_start|>user");
      out.push(`\n<tool_response>\n${content}\n</tool_response>`);
      if (next ? next.role !== "tool" : true) out.push("<|im_end|>\n");
    } else {
      throw new Error("Unexpected message role.");
    }
  });
  out.push("<|im_start|>assistant\n");
  out.push(
    body.chat_template_kwargs?.enable_thinking === false
      ? "<think>\n\n</think>\n\n"
      : "<think>\n",
  );
  return out.join("");
}

/**
 * The text an answer adds to the conversation as the next request renders
 * it, so `prompt(previous) + output(previous)` can be compared with the next
 * prompt: everything before the generation prompt is the previous request's
 * conversation, and the server cached it with the answer after it.
 */
export function withoutGenerationPrompt(prompt: string): string {
  const marker = "<|im_start|>assistant\n";
  const at = prompt.lastIndexOf(marker);
  return at < 0 ? prompt : prompt.slice(0, at);
}

/** Index of the first character where two strings differ (or the shorter length). */
export function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
