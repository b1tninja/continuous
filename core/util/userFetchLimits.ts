import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  DEFAULT_FETCH_DEADLINE_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "./boundedBody";
import { getContinueGlobalPath } from "./paths";

/**
 * The person's own limits for fetched web pages, read straight from their
 * config.yaml and from no other file, like `readUserLargeChangeLines`: a
 * workspace file that could raise the byte ceiling could make the agent read
 * what it should not.
 *
 * `toolPermissions.auto.environment.fetchMaxBytes` (default 2 MiB) and
 * `fetchTimeoutSeconds` (default 20). Values that are not whole numbers of at
 * least 1 are ignored, and the ceiling cannot exceed 64 MiB.
 */
export interface FetchLimits {
  maxBytes: number;
  deadlineMs: number;
}

const MAX_CEILING = 64 * 1024 * 1024;
const MAX_DEADLINE_S = 300;

interface Cached {
  mtimeMs: number;
  size: number;
  value: FetchLimits;
}

const cache = new Map<string, Cached>();

function wholeNumber(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? Math.min(value, max)
    : undefined;
}

export function parseFetchLimits(environment: unknown): FetchLimits {
  const env = (environment ?? {}) as Record<string, unknown>;
  const seconds = wholeNumber(env.fetchTimeoutSeconds, MAX_DEADLINE_S);
  return {
    maxBytes:
      wholeNumber(env.fetchMaxBytes, MAX_CEILING) ?? DEFAULT_MAX_BODY_BYTES,
    deadlineMs: seconds ? seconds * 1000 : DEFAULT_FETCH_DEADLINE_MS,
  };
}

// TODO(WB27): when the `web:` config section lands, read `web.limits.maxBytes`
// and `web.limits.timeoutSeconds` here (personal file, tighten-only from a
// workspace), keeping the two keys below as aliases. Every web path (fetch
// tool, `@url`, favicon page, search, `@google`) takes its limits from this
// function, so this is the one place the new keys plug in.
export function readUserFetchLimits(
  file = path.join(getContinueGlobalPath(), "config.yaml"),
): FetchLimits {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const root = YAML.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    const value = parseFetchLimits(root?.toolPermissions?.auto?.environment);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    cache.delete(file);
    return parseFetchLimits(undefined);
  }
}
