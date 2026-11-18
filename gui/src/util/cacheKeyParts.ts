import type { ChatMessage, Tool, ToolChoice } from "core";

/**
 * Parts of the prompt cache key beyond the model, system prompt and messages.
 * Anthropic documents that changes to these rebuild the cache (see
 * plans/research/caching-context-cost.md, M1 and M2).
 */

/** A tool as the key sees it: the name, plus what the model is told about it. */
export type KeyTool = string | Pick<Tool, "function">;

/** Stable JSON: object keys sorted, so key order never looks like an edit. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The text hashed for the tool list: each tool's name, description and input
 * schema, in order. A plain string is a name with nothing else known.
 */
export function toolsFingerprint(tools: KeyTool[]): string {
  return tools
    .map((t) =>
      typeof t === "string"
        ? t
        : stableJson([
            t.function.name,
            t.function.description ?? null,
            t.function.parameters ?? null,
          ]),
    )
    .join("\u0000");
}

/** The names alone, for the cause text. */
export function toolChoiceText(choice: ToolChoice | undefined): string {
  return choice ? `tool:${choice.function.name}` : "auto";
}

/** Whether any message carries an image. */
export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => p.type === "imageUrl"),
  );
}

/** The request settings that join the key, as the key stores them. */
export interface KeyRequestParts {
  effort?: string;
  toolChoice?: string;
  images?: boolean;
}

/**
 * Words for the request settings that differ. Both keys must carry a part
 * for it to be compared: a key made before the part existed says nothing.
 */
export function requestPartChanges(
  before: KeyRequestParts,
  after: KeyRequestParts,
): string[] {
  const changes: string[] = [];
  if (
    before.effort !== undefined &&
    after.effort !== undefined &&
    before.effort !== after.effort
  ) {
    changes.push("the reasoning effort or thinking settings changed");
  }
  if (
    before.toolChoice !== undefined &&
    after.toolChoice !== undefined &&
    before.toolChoice !== after.toolChoice
  ) {
    changes.push("the tool choice changed");
  }
  if (before.images !== undefined && after.images !== undefined) {
    if (!before.images && after.images) changes.push("an image was added");
    if (before.images && !after.images) changes.push("an image was removed");
  }
  return changes;
}
