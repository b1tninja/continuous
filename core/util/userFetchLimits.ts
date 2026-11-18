import {
  DEFAULT_FETCH_DEADLINE_MS,
  DEFAULT_MAX_BODY_BYTES,
} from "./boundedBody";
import { getWebConfig, readUserWebInputs, resolveWebConfig } from "./webConfig";

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

/**
 * The limits in force for @url and the fetch tool: `web.limits.maxBytes` and
 * `web.limits.timeoutSeconds` (core/util/webConfig.ts), with the old
 * `toolPermissions.auto.environment` keys as aliases. With a `file`, that file
 * alone is the person's config (tests, `config check <file>`).
 */
export function readUserFetchLimits(file?: string): FetchLimits {
  const limits = file
    ? resolveWebConfig({ ...readUserWebInputs(file), env: process.env }).config
        .limits
    : getWebConfig().limits;
  return {
    maxBytes: limits.maxBytes,
    deadlineMs: limits.timeoutSeconds * 1000,
  };
}
