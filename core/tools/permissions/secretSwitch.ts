import * as fs from "node:fs";
import * as path from "node:path";
import { getContinueGlobalPath } from "../../util/paths";
import { builtinIsOn, OPT_IN_RULES, type BuiltinRuleId } from "./policy";
import { readPolicyFile } from "./settingsFile";

/**
 * True while one of the person's built-in switches is off in permissions.yaml
 * (`builtin: <id>: false`). For the checks that run where the permission
 * evaluator is not in reach: the secret-file filter in indexing/ignore.ts and
 * the terminal tool's shell checks (runTerminalCommand.ts). The evaluator reads
 * the same switches from the approval it is given.
 *
 * The file is read again only when its size or modification time changes:
 * autocomplete asks on every keystroke. A missing or unreadable file means every
 * switch is on, the same as an absent key.
 */

let cache:
  { key: string; builtin: Partial<Record<string, boolean>> } | undefined;

function switchesIn(file: string): Partial<Record<string, boolean>> {
  try {
    const st = fs.statSync(file);
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    if (cache?.key === key) return cache.builtin;
    const builtin = readPolicyFile(file).settings.builtin ?? {};
    cache = { key, builtin };
    return builtin;
  } catch {
    cache = undefined;
    return {};
  }
}

export function builtinSwitchOff(id: BuiltinRuleId, file?: string): boolean {
  // The chat page has no Node modules: there every switch is on, as before
  try {
    const where =
      file ?? path.join(getContinueGlobalPath(), "permissions.yaml");
    return !builtinIsOn(switchesIn(where), id);
  } catch {
    // No file to read: a rule that is on unless named off stays on, an
    // opt-in rule stays off
    return OPT_IN_RULES.has(id);
  }
}

/** The "Commands and secrets" switch, for the secret-file filter. */
export function secretSwitchOff(file?: string): boolean {
  return builtinSwitchOff("protect-secrets", file);
}
