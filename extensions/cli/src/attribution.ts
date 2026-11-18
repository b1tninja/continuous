/**
 * Commit and pull-request attribution is the user's choice, never ours.
 *
 * Nothing is added to a commit message or PR text unless the person turns it on
 * in their own user settings file (`settings.json` in the global directory,
 * the same file the hooks loader reads; project files are ignored on purpose,
 * so a repository cannot switch it on for whoever opens it):
 *
 *   { "attribution": { "commit": true, "pullRequest": true,
 *                      "text": "Co-Authored-By: Me <me@example.com>" } }
 *
 * `text` is optional. The default names this product, never the upstream
 * project it is forked from, and uses a reserved `.invalid` address that
 * cannot belong to anyone (RFC 2606), so no real person or organisation is
 * credited by default.
 */
import * as fs from "fs";
import * as path from "path";

import { getGlobalDir } from "./hooks/hookTrust.js";
import { logger } from "./util/logger.js";

export const DEFAULT_ATTRIBUTION_TEXT =
  "Co-Authored-By: Continuous <noreply@continuous.invalid>";

export interface AttributionSettings {
  commit: boolean;
  pullRequest: boolean;
  text: string;
}

export function loadAttributionSettings(
  cwd: string = process.cwd(),
  homeDir?: string,
): AttributionSettings {
  const settings: AttributionSettings = {
    commit: false,
    pullRequest: false,
    text: DEFAULT_ATTRIBUTION_TEXT,
  };
  try {
    const dir = getGlobalDir(cwd, homeDir);
    if (!dir) return settings;
    const file = path.join(dir, "settings.json");
    if (!fs.existsSync(file)) return settings;
    const a = JSON.parse(fs.readFileSync(file, "utf-8"))?.attribution;
    if (a && typeof a === "object") {
      settings.commit = a.commit === true;
      settings.pullRequest = a.pullRequest === true;
      if (typeof a.text === "string" && a.text.trim()) {
        settings.text = a.text.trim();
      }
    }
  } catch (error) {
    logger.warn("Failed to read attribution settings:", error);
  }
  return settings;
}

/** The prompt segment for the enabled parts, or "" when both are off. */
export function attributionInstructions(s: AttributionSettings): string {
  const where = [
    s.commit ? "commit messages" : "",
    s.pullRequest ? "pull request descriptions" : "",
  ].filter(Boolean);
  if (where.length === 0) return "";
  return `The user asked for attribution in ${where.join(" and ")}. When you write one, end it with this line, exactly as given:\n${s.text}\n`;
}
