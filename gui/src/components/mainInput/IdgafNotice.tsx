import { useState } from "react";
import {
  idgafAreasOf,
  idgafStartLine,
} from "core/tools/permissions/idgafNotice";
import { useAppSelector } from "../../redux/hooks";
import { NoticeBar } from "./NoticeBar";

/** Chat sessions whose IDGAF line was dismissed, for the life of the webview. */
const dismissedSessions = new Set<string>();

/** For tests: show the line again in every session. */
export function resetIdgafNoticeForTests(): void {
  dismissedSessions.clear();
}

/**
 * The IDGAF start line (D-001, D-002): one line above the input while no
 * safety check is on, once per chat session. It says that rules, locked rules
 * and protected files stop nothing. It is a notice, never a question:
 * nothing waits on it, and dismissing it changes no level.
 */
export function IdgafNotice() {
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const builtin = useAppSelector((s) => s.ui.policyExtras.builtin);
  const sessionId = useAppSelector((s) => s.session.id);
  const [, setDismissed] = useState(0);

  const areas = idgafAreasOf(levels, builtin);
  if (areas.length === 0 || dismissedSessions.has(sessionId)) return null;

  return (
    <NoticeBar
      testId="idgaf-notice"
      onDismiss={() => {
        dismissedSessions.add(sessionId);
        setDismissed((n) => n + 1);
      }}
    >
      <span>{idgafStartLine({ areas })}</span>
    </NoticeBar>
  );
}
