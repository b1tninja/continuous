/**
 * Tool search (plans/tool-overhead.md): when the MCP tools a session carries
 * cost more than a token budget, offer the ones that fit plus one
 * `search_tools` meta-tool, and let the model pull the rest in by keyword.
 *
 * Pure functions, no imports from the model clients, so the webview can
 * import this file. Off by default (`experimental.toolSearch`, or
 * CONTINUE_TOOL_SEARCH in the CLI); with it off nothing here runs and the
 * request is byte-identical to before.
 *
 * The tool list is the first part of every cached prefix, so the order is a
 * contract: built-in tools in the caller's order, then MCP tools by name,
 * then the meta-tool, then tools the model activated, in the order it
 * activated them. An activation appends and never reorders. It does change
 * the list, so it costs one cache re-read; Anthropic's hosted tool search
 * avoids that by putting the definition in a message, which a client-side
 * list cannot do.
 */

export type ToolSearchMode = "off" | "auto";

export const SEARCH_TOOLS_NAME = "search_tools";

/** First line of a search result: the names the model may call from its next message. */
export const ACTIVATED_PREFIX = "activated:";

/**
 * MCP tool tokens above which `auto` engages. Proposal: 2% of a 200K window,
 * between the fixture's 20-tool set (about 2,400 tokens) and its 60-tool set
 * (about 6,100). Real servers run heavier, so real installs pass it sooner.
 */
export const DEFAULT_TOOL_BUDGET_TOKENS = 4000;

/** Model families that choose worse among many tools get a smaller budget. Unmeasured. */
const SMALL_MODEL_FAMILY = /nova|qwen|llama|gemma|phi|mistral-small|granite/i;
export const SMALL_MODEL_BUDGET_SCALE = 0.5;

export function resolveToolSearchMode(
  setting?: string | null,
  env: Record<string, string | undefined> = process.env,
): ToolSearchMode {
  const v = (setting ?? env.CONTINUE_TOOL_SEARCH)?.trim().toLowerCase();
  return v === "auto" ? "auto" : "off";
}

/** How selectTools reads a tool of either shape (the IDE's and the CLI's). */
export interface ToolAdapter<T> {
  name(tool: T): string;
  description(tool: T): string;
  parameters(tool: T): unknown;
  /** True for tools that always stay (built-in). */
  isCore(tool: T): boolean;
}

/** About 4 characters a token: the estimate used when no tokenizer is passed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function toolTokens<T>(
  tool: T,
  adapter: ToolAdapter<T>,
  count: (text: string) => number = estimateTokens,
): number {
  return count(
    JSON.stringify({
      name: adapter.name(tool),
      description: adapter.description(tool),
      parameters: adapter.parameters(tool),
    }),
  );
}

const byName = <T>(adapter: ToolAdapter<T>) => {
  return (a: T, b: T) => {
    const x = adapter.name(a);
    const y = adapter.name(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
};

export interface SelectToolsInput<T> {
  mode: "chat" | "plan" | "agent";
  /** Model family or id; only used to scale the budget. */
  family?: string;
  /** Tools that always stay, in the order the caller offers them today. */
  coreTools: T[];
  mcpTools: T[];
  budgetTokens: number;
  /** The meta-tool to offer when engaged; built by `makeSearchToolsTool`. */
  metaTool: (deferred: ToolIndexEntry[]) => T;
  adapter: ToolAdapter<T>;
  /** Names the model has found with the meta-tool, in the order it found them. */
  activatedNames?: readonly string[];
  count?: (text: string) => number;
}

export interface SelectToolsResult<T> {
  tools: T[];
  /** True when the budget was exceeded and tools were deferred. */
  engaged: boolean;
  deferred: ToolIndexEntry[];
  mcpTokens: number;
  budgetTokens: number;
}

export function effectiveBudget(budgetTokens: number, family?: string): number {
  return family && SMALL_MODEL_FAMILY.test(family)
    ? Math.floor(budgetTokens * SMALL_MODEL_BUDGET_SCALE)
    : budgetTokens;
}

/**
 * The tool list for a request. Under the budget it is the core tools then the
 * MCP tools by name, which is the list the selectors build today. Over it,
 * MCP tools are kept in name order while they fit (after reserving room for
 * the meta-tool), the rest are deferred, and the meta-tool follows; tools the
 * model activated are appended after it.
 */
export function selectTools<T>(
  input: SelectToolsInput<T>,
): SelectToolsResult<T> {
  const { adapter, mode } = input;
  const count = input.count ?? estimateTokens;
  const budget = effectiveBudget(input.budgetTokens, input.family);
  const mcp = [...input.mcpTools].sort(byName(adapter));
  const mcpTokens = mcp.reduce((n, t) => n + toolTokens(t, adapter, count), 0);

  if (mode === "chat") {
    return {
      tools: [],
      engaged: false,
      deferred: [],
      mcpTokens,
      budgetTokens: budget,
    };
  }
  if (mcpTokens <= budget) {
    return {
      tools: [...input.coreTools, ...mcp],
      engaged: false,
      deferred: [],
      mcpTokens,
      budgetTokens: budget,
    };
  }

  const reserve = toolTokens(input.metaTool([]), adapter, count);
  const kept: T[] = [];
  const deferredTools: T[] = [];
  let used = reserve;
  for (const tool of mcp) {
    const cost = toolTokens(tool, adapter, count);
    if (deferredTools.length === 0 && used + cost <= budget) {
      kept.push(tool);
      used += cost;
    } else {
      // Once one tool does not fit, the rest are deferred too, so the kept
      // set is a name-ordered prefix and does not skip around
      deferredTools.push(tool);
    }
  }
  const deferred = deferredTools.map((t) => indexEntry(t, adapter));
  const byToolName = new Map(deferredTools.map((t) => [adapter.name(t), t]));
  const activated: T[] = [];
  const seen = new Set<string>();
  for (const n of input.activatedNames ?? []) {
    const t = byToolName.get(n);
    if (t && !seen.has(n)) {
      seen.add(n);
      activated.push(t);
    }
  }
  const stillDeferred = deferred.filter((e) => !seen.has(e.name));
  return {
    tools: [
      ...input.coreTools,
      ...kept,
      // Every deferred name, activated or not: the description is a function
      // of the tool set alone, so an activation only appends the tool
      input.metaTool(deferred),
      ...activated,
    ],
    engaged: true,
    deferred: stillDeferred,
    mcpTokens,
    budgetTokens: budget,
  };
}

// ---- the index ----

export interface ToolIndexEntry {
  name: string;
  /** First sentence of the description, at most 140 characters. */
  line: string;
}

export function oneLine(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function indexEntry<T>(tool: T, adapter: ToolAdapter<T>): ToolIndexEntry {
  return {
    name: adapter.name(tool),
    line: oneLine(adapter.description(tool)),
  };
}

export function tokenizeQuery(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Keyword search over name and one-line description. A query term scores 3 for
 * a whole-word hit in the name, 2 for a prefix hit in the name, 1 for a word
 * in the description. Ties break by name, so the same query always returns
 * the same list.
 */
export function searchIndex(
  index: readonly ToolIndexEntry[],
  query: string,
  limit = 5,
): ToolIndexEntry[] {
  const terms = [...new Set(tokenizeQuery(query))];
  if (terms.length === 0) return [];
  const scored: { entry: ToolIndexEntry; score: number }[] = [];
  for (const entry of index) {
    const nameWords = tokenizeQuery(entry.name);
    const descWords = new Set(tokenizeQuery(entry.line));
    let score = 0;
    for (const term of terms) {
      if (nameWords.includes(term)) score += 3;
      else if (nameWords.some((w) => w.startsWith(term))) score += 2;
      if (descWords.has(term)) score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0),
  );
  return scored.slice(0, Math.max(1, limit)).map((s) => s.entry);
}

/** Largest number of names the meta-tool's description lists. */
export const MAX_LISTED_NAMES = 80;

export function searchToolsDescription(
  deferred: readonly ToolIndexEntry[],
): string {
  const names = deferred.slice(0, MAX_LISTED_NAMES).map((e) => e.name);
  const more = deferred.length - names.length;
  return (
    `Find tools that are not in your tool list yet. Give a few keywords; ` +
    `the result names the best matches with a one-line description each, ` +
    `and those tools can be called from your next message. ` +
    (names.length
      ? `Available to find: ${names.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`
      : "")
  );
}

/**
 * The text a search returns, as an ordinary tool result. The first line is
 * machine-readable (`activated: a, b`): the caller reads it back out of the
 * history to learn which tools to append next turn.
 */
export function formatSearchResult(
  matches: readonly ToolIndexEntry[],
  query: string,
): string {
  if (matches.length === 0) {
    return `${ACTIVATED_PREFIX} none\nNo tool matches "${query}". Try other keywords, or one of the names listed in this tool's description.`;
  }
  return [
    `${ACTIVATED_PREFIX} ${matches.map((m) => m.name).join(", ")}`,
    ...matches.map((m) => `- ${m.name}: ${m.line}`),
    "These tools can be called from your next message.",
  ].join("\n");
}

/** Reads the names back out of a result written by `formatSearchResult`. */
export function parseActivated(resultText: string): string[] {
  const first = resultText.trimStart().split("\n", 1)[0] ?? "";
  if (!first.startsWith(ACTIVATED_PREFIX)) return [];
  const rest = first.slice(ACTIVATED_PREFIX.length).trim();
  if (!rest || rest === "none") return [];
  return rest
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Names from every search result in a conversation, first activation first, no repeats. */
export function activatedFromResults(resultTexts: Iterable<string>): string[] {
  const out: string[] = [];
  for (const text of resultTexts) {
    for (const name of parseActivated(text)) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}
