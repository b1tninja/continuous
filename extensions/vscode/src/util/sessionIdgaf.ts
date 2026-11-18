import { POLICY_AREAS, type PolicyArea } from "core/tools/permissions/policy";

/**
 * The areas the person set to IDGAF in this editor session. permissions.yaml
 * never stores IDGAF, so the webview reads its levels from that file on every
 * load; without this, reloading the webview or restarting the extension host
 * in the middle of an unattended run dropped IDGAF and the run went back to
 * asking.
 *
 * It is kept in the workspace state under the editor's session id
 * (`vscode.env.sessionId`). That id stays the same for a webview reload and an
 * extension host restart, and is new when the editor starts again or a new
 * window opens. A new session therefore starts at the saved, non-IDGAF levels.
 */
export const SESSION_IDGAF_KEY = "continuous.sessionIdgaf";

export interface SessionStateStore {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

interface Saved {
  session: string;
  areas: PolicyArea[];
}

const areasOf = (value: unknown): PolicyArea[] =>
  Array.isArray(value) ? POLICY_AREAS.filter((a) => value.includes(a)) : [];

/** The areas at IDGAF in this session; none for another session or nothing saved. */
export function readSessionIdgaf(
  store: SessionStateStore,
  sessionId: string,
): PolicyArea[] {
  try {
    const saved = store.get(SESSION_IDGAF_KEY) as Partial<Saved> | undefined;
    if (!saved || saved.session !== sessionId) return [];
    return areasOf(saved.areas);
  } catch {
    return [];
  }
}

/** Remembers the areas at IDGAF for this session; none clears the entry. */
export async function writeSessionIdgaf(
  store: SessionStateStore,
  sessionId: string,
  areas: unknown,
): Promise<PolicyArea[]> {
  const kept = areasOf(areas);
  await store.update(
    SESSION_IDGAF_KEY,
    kept.length
      ? ({ session: sessionId, areas: kept } satisfies Saved)
      : undefined,
  );
  return kept;
}
