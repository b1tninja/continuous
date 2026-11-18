import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";
import type { EnvNameOptions } from "./envNames";

/**
 * The person's own `toolPermissions.auto.environment.envNames` (`ask` and
 * `allow` lists of variable names or `PREFIX*` patterns), read directly from
 * the user-level config.yaml. An `allow` entry loosens what asks, so an
 * assistant, a hub block or a repository file cannot be its source (only the
 * user's own config may loosen). Even then an `allow` entry never lowers a
 * name the built-in policy marks dangerous (envNames.ts).
 */
function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

export function sanitizeEnvNames(raw: unknown): EnvNameOptions | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const ask = list(r.ask);
  const allow = list(r.allow);
  if (!ask && !allow) return undefined;
  return { ...(ask ? { ask } : {}), ...(allow ? { allow } : {}) };
}

interface Cached {
  stamp: string;
  value: EnvNameOptions | undefined;
}

const cache = new Map<string, Cached>();

/** Changes when the file is edited, created or removed: a stat, not a read. */
function stampOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

/**
 * The person's own env-name lists. The file is parsed once and the result
 * reused until its modification time or size changes, so a tool call costs a
 * stat and not a read. A file that cannot be read or parsed gives undefined
 * (the built-in lists apply).
 */
export function readUserEnvNames(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): EnvNameOptions | undefined {
  const stamp = stampOf(file);
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  let value: EnvNameOptions | undefined;
  if (stamp !== "missing") {
    try {
      const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as any;
      value = sanitizeEnvNames(
        parsed?.toolPermissions?.auto?.environment?.envNames,
      );
    } catch {
      value = undefined;
    }
  }
  cache.set(file, { stamp, value });
  return value;
}

/** Forget what was read (tests, and a caller that just wrote the file). */
export function clearUserEnvNamesCache(): void {
  cache.clear();
}
