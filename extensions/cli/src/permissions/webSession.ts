import { webGrantsFor } from "core/tools/permissions/webGrants.js";

/**
 * The session the terminal agent's Web grants live in: the same id core's
 * engine is given (coreRules.ts, CLI_SESSION_ID). Kept apart so the ask's UI
 * can grant without loading the engine.
 */
export const CLI_WEB_SESSION = "cli";

/** "Allow <host> for this session" in the ask (WB45): gone when the process ends. */
export function grantWebHostForSession(host: string): void {
  webGrantsFor(CLI_WEB_SESSION).allowOnce(host);
}
