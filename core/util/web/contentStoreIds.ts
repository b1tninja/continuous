/**
 * Store ids of the web content store (contentStore.ts) that the gui also
 * builds, kept apart from the store so the gui does not bundle node:crypto.
 */

export const SUBAGENT_SEPARATOR = "/subagent/";

/** The store id of a subagent's run: its own pages, which its parent cannot read. */
export function subagentStoreId(
  parentSessionId: string,
  runId: string,
): string {
  return `${parentSessionId}${SUBAGENT_SEPARATOR}${runId}`;
}
