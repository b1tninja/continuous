/**
 * The tainted-session flag (plans/design/tainted-session.md, ROADMAP X4).
 *
 * Per session, a monotone set of labels: once untrusted content has entered
 * the conversation, its label stays recorded (with the turn it first entered)
 * until the person clears it, all at once or one label at a time. Nothing
 * about the content is kept: not the text, not the URL, not a hash. The state
 * is a few bytes per session.
 *
 * `secret` is the one confidentiality label: a secret was read into the
 * session (a protected secret path, a credential printed by a command). It
 * says private data is present, not that the content is untrusted, so on its
 * own it raises only the sinks that send data out (`taintRule.ts`).
 *
 * An MCP result is labelled per server, `mcp:<server>`, so acknowledging one
 * server's output does not forgive another's. `mcp-result` remains for a
 * result whose server the host cannot name.
 */
export const TAINT_KINDS = [
  "web-fetch",
  "mcp-result",
  "outside-read",
  "untrusted-workspace",
  "issue-text",
  "secret",
] as const;
export type TaintKind = (typeof TAINT_KINDS)[number];
/** A fixed kind, or the label of one MCP server's results. */
export type TaintLabel = TaintKind | `mcp:${string}`;

const MAX_SERVER_LABEL_CHARS = 40;

/**
 * The label for a result from this MCP server. The name can come from a file
 * in the open folder and is shown to the reviewer, so it is cut to letters,
 * digits, dot, underscore and hyphen, and to 40 characters.
 */
export function mcpLabel(server: string | undefined): TaintLabel {
  const word = (server ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SERVER_LABEL_CHARS);
  return word ? `mcp:${word}` : "mcp-result";
}

/** Whether a word, as typed by the person, is a label the registry could hold. */
export function isTaintLabel(word: string): word is TaintLabel {
  return (
    (TAINT_KINDS as readonly string[]).includes(word) ||
    /^mcp:[A-Za-z0-9._-]{1,40}$/.test(word)
  );
}

/** Fixed kinds in their order, each server's label after `mcp-result`, by name. */
function ordered(labels: Iterable<TaintLabel>): TaintLabel[] {
  const all = new Set(labels);
  const servers = [...all]
    .filter((l) => l.startsWith("mcp:"))
    .sort((a, b) => a.localeCompare(b));
  const out: TaintLabel[] = [];
  for (const k of TAINT_KINDS) {
    if (all.has(k)) out.push(k);
    if (k === "mcp-result") out.push(...servers);
  }
  return out;
}

/** What the evaluator, the reviewer prompt and the audit record are given. */
export interface TaintFact {
  /** Labels in a fixed order */
  kinds: TaintLabel[];
  /** The turn the first source entered, when the host counts turns */
  firstTurn?: number;
}

/** What ends a taint: the person's own action, or a new session. */
export type TaintClearReason = "user-ack" | "untaint-command" | "new-session";

/** How a label arrived: a tool's result, a subagent handing it back, or a fork. */
export type TaintAddReason = "tool-result" | "subagent" | "inherited";

/**
 * One label added to or cleared from a session, for the audit trail. `source`
 * is the tool that brought the content in (an add) or the control that
 * cleared it (a clear).
 */
export interface TaintChange {
  session: string;
  op: "add" | "clear";
  label: TaintLabel;
  turn?: number;
  source?: string;
  reason: TaintAddReason | TaintClearReason;
}

interface Entry {
  turn?: number;
  /** Copied from a parent at fork: a join does not hand it back */
  inherited: boolean;
}

type SessionTaint = Map<TaintLabel, Entry>;

const MAX_BOUND_CALLS = 500;
/** A host with no session id of its own shares this one */
export const DEFAULT_TAINT_SESSION = "default";

export class TaintRegistry {
  private readonly sessions = new Map<string, SessionTaint>();
  private readonly callSession = new Map<string, string>();
  private listener?: (change: TaintChange) => void;

  /** Who hears of every add and clear (the audit trail). One at a time. */
  setListener(listener: ((change: TaintChange) => void) | undefined): void {
    this.listener = listener;
  }

  private emit(change: TaintChange): void {
    try {
      this.listener?.(change);
    } catch {
      // the record is a nicety; it never changes the taint
    }
  }

  /** Add a source. Returns true when this label was not already recorded. */
  mark(
    session: string,
    kind: TaintLabel,
    turn?: number,
    origin: { source?: string; reason?: TaintAddReason } = {},
  ): boolean {
    let entries = this.sessions.get(session);
    if (!entries) this.sessions.set(session, (entries = new Map()));
    if (entries.has(kind)) return false;
    entries.set(kind, {
      inherited: false,
      ...(turn === undefined ? {} : { turn }),
    });
    this.emit({
      session,
      op: "add",
      label: kind,
      ...(turn === undefined ? {} : { turn }),
      ...(origin.source ? { source: origin.source } : {}),
      reason: origin.reason ?? "tool-result",
    });
    return true;
  }

  fact(session: string): TaintFact | undefined {
    const entries = this.sessions.get(session);
    if (!entries || entries.size === 0) return undefined;
    const kinds = ordered(entries.keys());
    const turns = [...entries.values()]
      .map((e) => e.turn)
      .filter((t): t is number => t !== undefined);
    return {
      kinds,
      ...(turns.length ? { firstTurn: Math.min(...turns) } : {}),
    };
  }

  /**
   * Clear the session, or only the labels named. Returns the labels that were
   * cleared; each is reported to the listener with the reason and the
   * control that cleared it.
   */
  clear(
    session: string,
    reason: TaintClearReason,
    source?: string,
    labels?: readonly TaintLabel[],
  ): TaintLabel[] {
    const held = this.fact(session)?.kinds ?? [];
    const entries = this.sessions.get(session);
    const cleared = labels ? held.filter((l) => labels.includes(l)) : held;
    if (!labels || cleared.length === held.length) {
      this.sessions.delete(session);
    } else {
      for (const l of cleared) entries?.delete(l);
    }
    for (const label of cleared) {
      this.emit({
        session,
        op: "clear",
        label,
        reason,
        ...(source ? { source } : {}),
      });
    }
    return cleared;
  }

  /** A child agent that has its own session id starts as tainted as its parent. */
  fork(parent: string, child: string): void {
    const from = this.sessions.get(parent);
    if (!from || from.size === 0) return;
    const copy: SessionTaint = new Map();
    for (const [kind, e] of from) copy.set(kind, { ...e, inherited: true });
    this.sessions.set(child, copy);
    for (const [kind, e] of copy) {
      this.emit({
        session: child,
        op: "add",
        label: kind,
        ...(e.turn === undefined ? {} : { turn: e.turn }),
        source: parent,
        reason: "inherited",
      });
    }
  }

  /** What the child met comes back to the parent; what it only inherited does not. */
  join(child: string, parent: string): void {
    const from = this.sessions.get(child);
    if (!from) return;
    for (const [kind, e] of from) {
      if (!e.inherited) {
        this.mark(parent, kind, e.turn, { source: child, reason: "subagent" });
      }
    }
  }

  /** The call's session, so a result that carries only a call id finds it. */
  bindCall(callId: string, session: string): void {
    this.callSession.delete(callId);
    this.callSession.set(callId, session);
    while (this.callSession.size > MAX_BOUND_CALLS) {
      const oldest = this.callSession.keys().next().value;
      if (oldest === undefined) break;
      this.callSession.delete(oldest);
    }
  }

  sessionOfCall(callId: string | undefined): string | undefined {
    return callId === undefined ? undefined : this.callSession.get(callId);
  }

  reset(): void {
    this.sessions.clear();
    this.callSession.clear();
  }
}

export const taintRegistry = new TaintRegistry();
