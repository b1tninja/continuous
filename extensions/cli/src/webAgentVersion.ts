import { setWebAgentVersion } from "core/web/webHeaders.js";

import { getVersion } from "./version.js";

/**
 * The CLI's version, read once at startup and also handed to the web
 * User-Agent (`Continuous-User/<major.minor>`, core/web/webHeaders.ts), so
 * `Fetch` names this release and nothing more precise.
 */
export function startupVersion(): string {
  const version = getVersion();
  setWebAgentVersion(version);
  return version;
}
