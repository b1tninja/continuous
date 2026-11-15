/**
 * Changing tools while the prompt cache is warm (ROADMAP C80 and C88).
 *
 * Providers cache a request's prompt by prefix in the order tools, system,
 * messages, so any change to the tool list (a tool turned on or off, an MCP
 * server connecting, a description that changed) makes the next request write
 * the whole conversation to the cache again instead of reading it. While the
 * cache is warm and that re-read is significant, a change to the list waits:
 * the request keeps offering the list the previous request offered, a tool
 * turned off in the meantime stays in it and is refused when called
 * ("withheld, not removed"), and a tool turned on is not offered yet. The
 * change applies on the first request after the cache goes cold, after a
 * compaction, in a new session, or when the person asks for it now.
 *
 * Plain TypeScript with no node imports: the GUI and the CLI share it.
 */

/** The tool list a request offered, and the context it was offered in. */
export interface HeldToolList<T> {
  /**
   * What the list depends on besides the person's toggles: the mode, the
   * model, Loop mode's item. A different key is an intentional rebuild (a
   * mode or model switch warns on its own), so the held list is dropped.
   */
  key: string;
  tools: T[];
}

/** How the list the person wants differs from the list being sent. */
export interface PendingToolChanges {
  /** Turned on, or offered by a server that connected late */
  added: string[];
  /** Turned off, or gone with its server: withheld while the cache is warm */
  removed: string[];
  /** Same name, different description or schema */
  changed: string[];
}

export const NO_TOOL_CHANGES: PendingToolChanges = {
  added: [],
  removed: [],
  changed: [],
};

export function countToolChanges(p: PendingToolChanges): number {
  return p.added.length + p.removed.length + p.changed.length;
}

export function pendingToolChanges<T>(
  sent: readonly T[],
  live: readonly T[],
  nameOf: (tool: T) => string,
  fingerprintOf: (tool: T) => string,
): PendingToolChanges {
  const sentByName = new Map(sent.map((t) => [nameOf(t), t]));
  const liveByName = new Map(live.map((t) => [nameOf(t), t]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, tool] of liveByName) {
    const before = sentByName.get(name);
    if (!before) added.push(name);
    else if (fingerprintOf(before) !== fingerprintOf(tool)) changed.push(name);
  }
  for (const name of sentByName.keys()) {
    if (!liveByName.has(name)) removed.push(name);
  }
  return { added, removed, changed };
}

/** A stable summary of a pending set, to remember that a choice was made for it. */
export function toolChangesId(p: PendingToolChanges): string {
  return JSON.stringify([
    [...p.added].sort(),
    [...p.removed].sort(),
    [...p.changed].sort(),
  ]);
}

export interface ToolListDecision<T> {
  /** The list this request offers */
  tools: T[];
  /** True when that is the held list and a change is waiting */
  held: boolean;
  pending: PendingToolChanges;
}

/**
 * The list to offer: the held one while `hold` is true, the context is the
 * same and something changed; otherwise the live one (which applies whatever
 * was waiting).
 */
export function resolveToolList<T>(args: {
  live: readonly T[];
  held: HeldToolList<T> | undefined;
  key: string;
  /** The cache is warm, the re-read is significant, and nothing said apply now */
  hold: boolean;
  nameOf: (tool: T) => string;
  fingerprintOf: (tool: T) => string;
}): ToolListDecision<T> {
  const { live, held, key, hold } = args;
  if (!hold || !held || held.key !== key) {
    return { tools: [...live], held: false, pending: NO_TOOL_CHANGES };
  }
  const pending = pendingToolChanges(
    held.tools,
    live,
    args.nameOf,
    args.fingerprintOf,
  );
  if (countToolChanges(pending) === 0) {
    return { tools: [...live], held: false, pending: NO_TOOL_CHANGES };
  }
  return { tools: [...held.tools], held: true, pending };
}

/**
 * When a change to the tool list takes effect: at once when the cache is
 * cold, the re-read is small or the person turned the wait off; otherwise it
 * waits for the cache to cool.
 */
export function toolChangeTiming(args: {
  warm: boolean;
  significant: boolean;
  /** The person's setting: always apply tool changes at once */
  applyAtOnce?: boolean;
}): "immediate" | "queue" {
  return args.warm && args.significant && !args.applyAtOnce
    ? "queue"
    : "immediate";
}

/** The fingerprint the GUI and the CLI compare: what the model reads of a tool. */
export function functionFingerprint(tool: { function?: unknown }): string {
  return JSON.stringify(tool.function ?? tool);
}

/** The second half of the refusal: the same as the other refusals'. */
const CARRY_ON =
  "Do not retry this call or reach the same result another way. Do what else the request needs, then say what you could not do and why.";

/**
 * The tool result for a call to a withheld tool. `gone` is a tool whose MCP
 * server disconnected or stopped offering it, rather than one turned off.
 */
export function withheldToolRefusal(name: string, gone = false): string {
  const why = gone
    ? `${name} is no longer available in this session (its MCP server disconnected or stopped offering it); the tool list updates when the prompt cache goes cold.`
    : `${name} is turned off for this session; the change applies when the prompt cache goes cold.`;
  return `${why}\n\n${CARRY_ON}`;
}

/**
 * Models that run preserved thinking's prefix check: a change to `tools[]`
 * invalidates the thinking blocks minted before it, and sending them back is
 * a 400 (always on Fable 5.2 and Mythos 5.2; possibly, depending on the
 * account, on Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5).
 * Source: plans/research/mid-session-tool-changes.md section 6.5 (PR #893),
 * from Anthropic's preserved-thinking prefix-check page; the Converse case
 * is inferred, not measured. Matched on the model id, so Bedrock ids
 * (`us.anthropic.claude-opus-5-5-...`) match too.
 */
const PRESERVED_THINKING_MODELS =
  /(?:fable|mythos)-5[-.][12]\b|(?:opus|sonnet|haiku)-5[-.]5\b/i;

/** Whether applying a tool list change on this model drops earlier reasoning. */
export function toolChangeDropsThinking(modelId: string | undefined): boolean {
  return !!modelId && PRESERVED_THINKING_MODELS.test(modelId);
}

/** What applying a change costs beyond the re-read, on such a model. */
export const DROPS_REASONING_TEXT =
  "rebuilds the cache and drops earlier reasoning";

/**
 * Where reasoning stops being sent after a tool list change: the history
 * length at the request that changed the list, so every thinking block
 * minted under the old list is left out of that request and the later ones.
 * `previous` is the cut an earlier change set; a new change moves it on.
 * Undefined when the model keeps its reasoning (no prefix check).
 */
export function thinkingCutAfterToolChange(args: {
  modelId: string | undefined;
  /** This request sends a different list than the previous one did */
  listChanged: boolean;
  historyLength: number;
  previous?: number;
}): number | undefined {
  if (!toolChangeDropsThinking(args.modelId)) return undefined;
  return args.listChanged ? args.historyLength : args.previous;
}

/**
 * Where reasoning stops being sent after a compaction, on a model with the
 * prefix check. A thinking block is bound to everything in front of it, so
 * reasoning in the turns a compaction kept was minted with the summarised
 * turns before it and is a 400 to send back after the summary ("keep-tail
 * compaction"). Where the summary sits does not change that: in the system
 * message (before C104) it changed `system`, after the head it changes the
 * messages. Reasoning minted after the compaction is valid. Undefined when
 * the model keeps its reasoning or there is no summary.
 */
export function thinkingCutAfterCompaction(args: {
  modelId: string | undefined;
  /** The history index of the item that carries the newest summary, or -1 */
  summaryIndex: number;
  /** The history length when that summary was made, if it was recorded */
  historyLengthAtCompaction?: number;
}): number | undefined {
  if (!toolChangeDropsThinking(args.modelId) || args.summaryIndex < 0) {
    return undefined;
  }
  // A session compacted before the length was recorded: the turns kept then
  // cannot be told apart from later ones, and nothing more is cut
  return Math.max(
    args.summaryIndex + 1,
    args.historyLengthAtCompaction ?? args.summaryIndex + 1,
  );
}

/** Whether two lists would be the same `tools[]` bytes. */
export function sameToolList<T>(
  a: readonly T[],
  b: readonly T[],
  fingerprintOf: (tool: T) => string,
): boolean {
  return (
    a.length === b.length &&
    a.every((t, i) => fingerprintOf(t) === fingerprintOf(b[i]))
  );
}

/** The warning at a control that changes the tool list. */
export function toolChangeWarning(
  rereadCost: string,
  dropsThinking = false,
): string {
  const extra = dropsThinking
    ? `; on this model it ${DROPS_REASONING_TEXT}`
    : "";
  return `Prompt cache is warm: changing the tool list re-reads about ${rereadCost} on the next request${extra}.`;
}

/** "1 tool change waiting for the cache to cool". */
export function pendingToolChangesText(count: number): string {
  return `${count} tool change${count === 1 ? "" : "s"} waiting for the cache to cool`;
}

/** The names a pending set touches, for a short list in a notice. */
export function describeToolChanges(p: PendingToolChanges): string {
  const parts = [
    ...p.added.map((n) => `+${n}`),
    ...p.removed.map((n) => `-${n}`),
    ...p.changed.map((n) => `~${n}`),
  ];
  return parts.join(", ");
}
