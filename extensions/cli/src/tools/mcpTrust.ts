import fs from "fs";
import path from "path";

import { inlineMcpServerNames } from "core/context/mcp/mcpTrust.js";

import { env } from "../env.js";
import { getPolicyExtras } from "../permissions/policyLevels.js";
import { services } from "../services/index.js";

let cached: { file: string; mtimeMs: number; names: Set<string> } | undefined;

/** Servers written inline in ~/.continue/config.yaml, when the CLI runs on it. */
function userConfigServers(): Set<string> {
  try {
    // --config or a saved assistant: not the person's own file
    if (services.config?.getState?.().configPath !== undefined) {
      return new Set();
    }
    const file = path.join(env.continueHome, "config.yaml");
    const { mtimeMs } = fs.statSync(file);
    if (cached?.file !== file || cached.mtimeMs !== mtimeMs) {
      cached = {
        file,
        mtimeMs,
        names: inlineMcpServerNames(fs.readFileSync(file, "utf8")),
      };
    }
    return cached.names;
  } catch {
    return new Set();
  }
}

/**
 * The MCP servers whose own `readOnlyHint` is believed: the person's
 * permissions.yaml (`mcpServers: { name: trusted }`) and the servers written in
 * their own config.yaml. Servers from a flag, an agent file or a hub assistant
 * are not in it, so their hint is ignored.
 */
export function cliTrustedMcpServers(): Set<string> {
  return new Set([
    ...Object.keys(getPolicyExtras().mcpServers ?? {}),
    ...userConfigServers(),
  ]);
}
