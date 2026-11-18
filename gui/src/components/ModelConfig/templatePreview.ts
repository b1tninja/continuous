import type { ChatMessage, TemplateType } from "core";
import { autodetectTemplateFunction } from "core/llm/autodetect";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_CHAT_SYSTEM_MESSAGE,
  DEFAULT_PLAN_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";
import Handlebars from "handlebars";

/**
 * Previews for the Templates & system message tab: what each setting makes
 * the model receive, rendered with the same functions core uses and made-up
 * sample values.
 */

/** The built-in system message for each `chatOptions` field, shown when it is empty. */
export const DEFAULT_SYSTEM_MESSAGES: Record<string, string> = {
  "chatOptions.baseSystemMessage": DEFAULT_CHAT_SYSTEM_MESSAGE,
  "chatOptions.baseAgentSystemMessage": DEFAULT_AGENT_SYSTEM_MESSAGE,
  "chatOptions.basePlanSystemMessage": DEFAULT_PLAN_SYSTEM_MESSAGE,
};

export type PromptTemplateKind = "edit" | "apply" | "autocomplete";

/**
 * The values core passes each Handlebars template (core/edit/streamDiffLines.ts
 * for edit and apply, core/autocomplete/templating for autocomplete), with a
 * sample for each.
 */
export const TEMPLATE_VARIABLES: Record<
  PromptTemplateKind,
  Record<string, string>
> = {
  edit: {
    userInput: "rename x to count",
    prefix: "function inc() {\n",
    codeToEdit: "  x = x + 1;",
    suffix: "\n}",
    language: "typescript",
  },
  apply: {
    original_code: "let x = 1;",
    new_code: "let count = 1;",
  },
  autocomplete: {
    prefix: "function add(a, b) {\n  return ",
    suffix: "\n}",
    filename: "math.ts",
    reponame: "my-repo",
    language: "TypeScript",
  },
};

const HELPERS = new Set(["if", "unless", "each", "with", "else", "this"]);

/** Names a Handlebars template reads, in order of first use. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  const re = /\{\{\{?[~#/^]?\s*([A-Za-z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const name = m[1].split(".")[0];
    if (!HELPERS.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export interface TemplatePreview {
  text?: string;
  error?: string;
  /** Variables the template reads that core never fills in for this kind. */
  unknown: string[];
}

/** A prompt template rendered with sample values, or why it does not compile. */
export function renderTemplatePreview(
  kind: PromptTemplateKind,
  template: string,
): TemplatePreview {
  const known = TEMPLATE_VARIABLES[kind];
  const unknown = templateVariables(template).filter(
    (v) => !(v in known) && !(kind === "edit" && v === "system_message"),
  );
  try {
    const text = Handlebars.compile(template, { strict: false })({
      ...known,
      ...(kind === "edit" ? { history: [] } : {}),
    });
    return { text, unknown };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message.split("\n")[0] : String(e),
      unknown,
    };
  }
}

const SAMPLE_CHAT: ChatMessage[] = [
  { role: "system", content: "<system message>" },
  { role: "user", content: "What does this function do?" },
];

/**
 * The raw prompt a chat template builds from a short conversation, or
 * undefined when the provider sends chat messages and applies the model's
 * own template (the setting then does nothing).
 */
export function chatTemplatePreview(
  model: string,
  provider: string,
  chosen: string | undefined,
): { text?: string } {
  const fn = autodetectTemplateFunction(
    model,
    provider,
    (chosen || undefined) as TemplateType | undefined,
  );
  if (!fn) return {};
  const out = fn(SAMPLE_CHAT.map((m) => ({ ...m })));
  return { text: typeof out === "string" ? out : JSON.stringify(out, null, 2) };
}
