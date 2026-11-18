/**
 * The editor's session environment (plans/research/env-disclosure-master-plan.md
 * 3.3, rows ENV13 and ENV14). The webview asks core once per session; core
 * gathers the snapshot for the workspace, renders the three texts once, and
 * freezes the terminal executor at the shell the snapshot names, so the
 * prompt and the executor cannot disagree when the setting changes during the
 * session. A resumed session sends its saved environment back: the executor
 * is frozen at its shell again and its texts are returned unchanged.
 */
import type { SessionEnvironment } from "..";

import type { Detail, Surface } from "./environmentContract";
import { renderEnvironment } from "./environmentPrompt";
import {
  DEFAULT_DETAIL,
  frozenTerminalShell,
  gatherEnvironment,
  isEnvironmentSnapshot,
  type GatherInput,
} from "./environmentSnapshot";
import { setSessionTerminalShell } from "./shell";

/** Chat, agent and plan get the same bytes, so a mode switch keeps the prefix. */
export const EDITOR_SURFACE: Surface = "ide-agent";

export interface EditorEnvironmentInput {
  /** The session's saved environment, when it has one. */
  saved?: SessionEnvironment;
  workspaceDirs: () => Promise<string[]>;
  remoteName?: () => Promise<string | undefined>;
  detail?: Detail;
  /** For tests: passed to the gatherer. */
  gather?: Partial<GatherInput>;
}

function stringsOf(env: SessionEnvironment): SessionEnvironment["strings"] {
  const d = renderEnvironment(env.snapshot, {
    surface: EDITOR_SURFACE,
    detail: env.detail,
  });
  return {
    systemLine: d.systemLine,
    toolSentence: d.toolSentence,
    firstMessageBlock: d.firstMessageBlock,
  };
}

export async function editorSessionEnvironment(
  input: EditorEnvironmentInput,
): Promise<SessionEnvironment> {
  const saved = input.saved;
  if (saved && isEnvironmentSnapshot(saved.snapshot)) {
    setSessionTerminalShell(frozenTerminalShell(saved.snapshot));
    return saved.strings ? saved : { ...saved, strings: stringsOf(saved) };
  }
  // A new session reads the setting as it is now
  setSessionTerminalShell(undefined);
  const [roots, remoteName] = await Promise.all([
    input.workspaceDirs().catch(() => [] as string[]),
    input.remoteName ? input.remoteName().catch(() => undefined) : undefined,
  ]);
  const snapshot = await gatherEnvironment({
    roots,
    remoteName,
    ...input.gather,
  });
  setSessionTerminalShell(frozenTerminalShell(snapshot));
  const env: SessionEnvironment = {
    snapshot,
    detail: input.detail ?? DEFAULT_DETAIL,
  };
  return { ...env, strings: stringsOf(env) };
}
