import type { Session } from "core/index.js";
import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import {
  idgafAreasOf,
  idgafStartLine,
} from "core/tools/permissions/idgafNotice.js";
import type { PolicyLevels } from "core/tools/permissions/policy.js";

import { logger } from "../util/logger.js";
import { userNotice } from "../util/userNotice.js";

/**
 * The CLI's one-line session notices about IDGAF (plans/decisions-2026-11-15.md,
 * D-001, D-002, ID 5 and B21). They are said, never asked: nothing here waits
 * for an answer or changes a level. Deliberately light (no services, no
 * session module), so session.ts can call it.
 */

/** The flag that turned IDGAF on for this process, when one did. */
let flagSource: string | undefined;
let announced = false;

/** The audit kind B21 writes when a session runs at IDGAF. */
export const IDGAF_SESSION_KIND = "idgaf-session";
/** The audit kind B21 writes for a loosening read from the environment. */
export const ENV_LOOSENING_KIND = "env-loosening";

/** `--auto` or `--policy <spec>` raised an area to IDGAF at start-up. */
export function rememberIdgafFlag(source: string | undefined): void {
  flagSource = source;
}

/** The line `--resume` prints for a session that ran at IDGAF (ID 5). */
export const RESUMED_WITHOUT_IDGAF_NOTICE =
  "Resumed at your configured levels: this session ran at IDGAF, and IDGAF is not restored. Pass --policy idgaf to turn it on again.";

/**
 * Called by session.ts on `--resume`: the IDGAF areas the session was saved
 * with are dropped (they are not restored) and the person is told once,
 * unless a flag of this process turned IDGAF on again.
 */
export function noteResumedSession(session: Session): void {
  if (!session.idgafAreas?.length) return;
  delete session.idgafAreas;
  if (flagSource) return;
  userNotice(RESUMED_WITHOUT_IDGAF_NOTICE, "resumed-without-idgaf");
}

/**
 * At the start of each main turn: the IDGAF line, once per process, while an
 * area is at IDGAF, with a B21 `idgaf-session` audit record; and the session is
 * marked so a later `--resume` can say IDGAF was not restored.
 */
export function announceIdgaf(
  levels: PolicyLevels,
  session: Session | undefined,
): void {
  const areas = idgafAreasOf(levels);
  if (areas.length === 0) return;
  if (session) {
    const marked = new Set([...(session.idgafAreas ?? []), ...areas]);
    session.idgafAreas = [...marked];
  }
  if (announced) return;
  announced = true;
  userNotice(idgafStartLine({ areas, source: flagSource }), "idgaf-start");
  try {
    getAuditTrail((m) => logger.warn(m)).setting({
      ...(session?.sessionId ? { session: session.sessionId } : {}),
      kind: IDGAF_SESSION_KIND,
      op: "set",
      source: flagSource ? "flag" : "cli-command",
      name: areas.join(", "),
      to: "idgaf",
      loosens: true,
      ...(flagSource ? { confirmed: "flag" as const } : {}),
    });
  } catch {
    // the audit never blocks a turn
  }
}

/**
 * B21: a loosening that came from an environment variable holds for every
 * run while it is set, unlike a session's IDGAF. Recorded once per process.
 */
export function auditEnvLoosening(
  variable: string,
  value: string,
  session?: string,
): void {
  try {
    getAuditTrail((m) => logger.warn(m)).setting({
      ...(session ? { session } : {}),
      kind: ENV_LOOSENING_KIND,
      op: "set",
      source: "env",
      name: variable,
      to: value,
      loosens: true,
    });
  } catch {
    // the audit never blocks start-up
  }
}

/** For tests: forget what was said. */
export function resetIdgafNotices(): void {
  flagSource = undefined;
  announced = false;
}
