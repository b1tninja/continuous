/**
 * Notices when the agent sends the same call again and again, so the harness
 * can say so instead of letting it spin. Gemini-style loop guards and
 * OpenHands' stuck detector do the same: count consecutive repeats and feed
 * back, rather than stop the run.
 *
 * Two kinds of repeat, because they need different words:
 *  - a call that was refused, sent again (or rewritten a little and sent again:
 *    a model that is told a command was refused tends to resend it with small
 *    edits, which a byte-for-byte comparison never sees);
 *  - a call that ran and gave the same result as the last time.
 *
 * Only calls that follow each other count: any different call in between
 * starts the count again. The text goes in the tool result, which is what the
 * model reads. This file imports nothing from Node and keeps its state in
 * memory, per session.
 */

/** A call that ran and gave this result is a repeat from the third time. */
export const REPEAT_RESULT_LIMIT = 3;
/** A refused call sent again is a repeat from the second time. */
export const REPEAT_REFUSAL_LIMIT = 2;

/** Two commands whose words overlap at least this much count as the same one. */
const SIMILAR = 0.8;

interface Last {
  tool: string;
  text: string;
  kind: "refused" | "ran";
  outcome: string;
  count: number;
  callId?: string;
}

const lastBySession = new Map<string, Last>();
const MAX_SESSIONS = 200;

/** The part of a call that says what it does: a command, or the arguments. */
export function callText(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (toolName === "run_terminal_command" && typeof a.command === "string") {
    return a.command.replace(/\s+/g, " ").trim();
  }
  try {
    const sorted = Object.fromEntries(
      Object.entries(a).sort(([x], [y]) => x.localeCompare(y)),
    );
    return JSON.stringify(sorted);
  } catch {
    return String(toolName);
  }
}

function words(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z0-9_./\\-]{2,}/g) ?? []);
}

/** Whether `b` is the call `a` again, or a small rewrite of it (commands only). */
export function sameCall(
  tool: string,
  a: string,
  b: string,
  otherTool = tool,
): boolean {
  if (tool !== otherTool) return false;
  if (a === b) return true;
  if (tool !== "run_terminal_command") return false;
  // A short command that differs is a different command
  if (Math.min(a.length, b.length) < 40) return false;
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both) >= SIMILAR;
}

/** A short stand-in for a result, to tell two results apart. */
export function outcomeKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++)
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
}

function remember(session: string, last: Last): void {
  if (!lastBySession.has(session) && lastBySession.size >= MAX_SESSIONS) {
    const oldest = lastBySession.keys().next().value;
    if (oldest !== undefined) lastBySession.delete(oldest);
  }
  lastBySession.set(session, last);
}

function record(
  session: string,
  tool: string,
  text: string,
  kind: Last["kind"],
  outcome: string,
  callId: string | undefined,
): number {
  const prev = lastBySession.get(session);
  // The same call asked about twice (a re-evaluation) is one call
  if (prev && callId && prev.callId === callId && prev.kind === kind) {
    return prev.count;
  }
  const repeat =
    prev !== undefined &&
    prev.kind === kind &&
    sameCall(tool, prev.text, text, prev.tool) &&
    (kind === "refused" || prev.outcome === outcome);
  const count = repeat ? prev.count + 1 : 1;
  remember(session, { tool, text, kind, outcome, count, callId });
  return count;
}

/** A call was refused: how many times in a row this call, or one like it, has been. */
export function recordRefusal(
  session: string,
  toolName: string,
  args: unknown,
  callId?: string,
): number {
  return record(
    session,
    toolName,
    callText(toolName, args),
    "refused",
    "",
    callId,
  );
}

/** A call ran: how many times in a row it has run with this same result. */
export function recordResult(
  session: string,
  toolName: string,
  args: unknown,
  resultText: string,
  callId?: string,
): number {
  return record(
    session,
    toolName,
    callText(toolName, args),
    "ran",
    outcomeKey(resultText),
    callId,
  );
}

const WAYS_OUT =
  "Change the approach: read what the output says and change what you run; put a script in a file with create_new_file and run that file; split the work into smaller calls; look with read_file, grep_search or ls instead of running something; or stop and tell the person what is in the way.";

/** What the model is told when a refused call comes back, or null before the limit. */
export function refusalSteer(count: number): string | null {
  if (count < REPEAT_REFUSAL_LIMIT) return null;
  return `You have sent this call, or one almost the same, ${count} times in a row and it was refused each time. Sending it again, or a small rewrite of it, will be refused the same way. ${WAYS_OUT}`;
}

/** What the model is told when a call ran with the same result again, or null before the limit. */
export function resultSteer(count: number): string | null {
  if (count < REPEAT_RESULT_LIMIT) return null;
  return `You just ran that same command ${count} times and got the same result each time. Running it again will not change the outcome. ${WAYS_OUT}`;
}

/** For tests. */
export function resetRepeatGuard(): void {
  lastBySession.clear();
}
