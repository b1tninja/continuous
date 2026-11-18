/**
 * Calls IDGAF ran that a rule or guard would have refused or asked about, in
 * this process: core's recorded objection (`idgafOverride`) or a Never
 * (`exclude`) entry of the CLI's own lists. Counted for the end-of-run line,
 * the stream-json `result` event and nothing else; it never reaches the model
 * and never stops a call.
 */
let count = 0;

export function noteIdgafObjection(): void {
  count++;
}

export function idgafObjectionCount(): number {
  return count;
}

export function resetIdgafObjections(): void {
  count = 0;
}

/** The one line printed at the end of a run, or undefined when there were none. */
export function idgafObjectionLine(): string | undefined {
  if (count === 0) return undefined;
  return `IDGAF ran ${count} call${count === 1 ? "" : "s"} that a rule or guard would have refused or asked about. Each is in the audit trail with what would have stopped it.`;
}
