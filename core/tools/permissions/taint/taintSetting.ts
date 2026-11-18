import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../../util/paths";

/**
 * `toolPermissions.auto.environment.taintedSessionRule: off | ask`, read from
 * the person's own config.yaml and from no other file: a workspace file that
 * could set it to `off` would switch the rule off for the content it came
 * with. Anything else than the word `ask` is `off`. Cached per file by
 * modification time and size, like userLimits.ts.
 */
export type TaintedSessionRule = "off" | "ask";

interface Cached {
  mtimeMs: number;
  size: number;
  value: TaintedSessionRule;
}

const cache = new Map<string, Cached>();

export function parseTaintedSessionRule(value: unknown): TaintedSessionRule {
  return value === "ask" ? "ask" : "off";
}

export function readTaintedSessionRule(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): TaintedSessionRule {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const root = YAML.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    const value = parseTaintedSessionRule(
      root?.toolPermissions?.auto?.environment?.taintedSessionRule,
    );
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    cache.delete(file);
    return "off";
  }
}
