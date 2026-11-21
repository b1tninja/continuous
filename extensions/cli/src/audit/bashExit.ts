/**
 * How the last Bash commands ended, by tool call id, for the audit trail.
 *
 * The Bash tool returns its output as a string, or throws it as a string when
 * the command failed with something on stderr, so the exit code is not in
 * what the stream code sees. The tool notes it here when the command ends and
 * the stream code takes it when it writes the outcome. Entries are taken once;
 * a call the stream code never takes (an aborted turn) is dropped when the map
 * grows past a small bound.
 */
export interface BashEnd {
  exit: number;
  signal?: string;
}

const ends = new Map<string, BashEnd>();
const MAX_KEPT = 200;

export function noteBashEnd(
  toolCallId: string | undefined,
  end: BashEnd,
): void {
  if (!toolCallId) return;
  ends.set(toolCallId, end);
  if (ends.size > MAX_KEPT) {
    // oldest first: Map keeps insertion order
    const oldest = ends.keys().next().value;
    if (oldest !== undefined) ends.delete(oldest);
  }
}

/** The end noted for this call, removed so it is used once. */
export function takeBashEnd(toolCallId: string): BashEnd | undefined {
  const end = ends.get(toolCallId);
  if (end) ends.delete(toolCallId);
  return end;
}

export function clearBashEndsForTests(): void {
  ends.clear();
}
