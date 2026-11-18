import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";
import { normalizeHost } from "./destinations";

/**
 * `host:` allow rules for the Web area (WB45, ahead of WB21's full
 * destination rules). Written in the `allow:` list of the person's own
 * permissions.yaml, by "Always allow <host>" in the terminal agent's ask or
 * by hand:
 *
 *   allow:
 *     - host:docs.example.com      that host only
 *     - host:*.example.com         its subdomains only, not example.com itself
 *
 * Matching is on whole labels after normalising (case, trailing dot,
 * brackets, IPv4 spellings), so `host:example.com` never covers
 * `evil-example.com` or `example.com.evil.test`, and `*.` covers one or more
 * labels in front, never part of one (DC-2). A rule with any other `*`, an
 * empty host, or a port is ignored: it allows nothing.
 *
 * Only the person's own file is read. A workspace or assistant file cannot
 * add a web allow rule (custom-policy.md 1.3), and there is no built-in list:
 * no host runs without the person's rule, grant or configured search backend.
 */

const PREFIX = /^host:/i;

/** The rule's host pattern, or undefined when it is not a usable `host:` rule. */
function patternOf(
  rule: string,
): { host: string; subdomains: boolean } | undefined {
  const text = rule.trim();
  if (!PREFIX.test(text)) return undefined;
  let host = text.replace(PREFIX, "").trim();
  const subdomains = host.startsWith("*.");
  if (subdomains) host = host.slice(2);
  if (!host || host.includes("*") || host.includes("/")) return undefined;
  // A port, or anything after the host, is not part of this rule form yet
  if (/:\d+$/.test(host) && !host.startsWith("[")) return undefined;
  const normalized = normalizeHost(host);
  if (!normalized || normalized.startsWith(".")) return undefined;
  return { host: normalized, subdomains };
}

/** True when the `host:` rule covers the host, on whole labels. */
export function hostRuleMatches(rule: string, host: string): boolean {
  const p = patternOf(rule);
  if (!p) return false;
  const h = normalizeHost(host);
  if (!h) return false;
  return p.subdomains ? h.endsWith(`.${p.host}`) : h === p.host;
}

/** The `host:` rules in a list of allow entries (others are the terminal agent's tool rules). */
export function hostAllowRules(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (v): v is string => typeof v === "string" && patternOf(v) !== undefined,
  );
}

/** The rule "Always allow <host>" writes: the exact host. */
export function hostAllowRuleFor(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string") return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const host = normalizeHost(url.hostname);
    return host ? `host:${host}` : undefined;
  } catch {
    return undefined;
  }
}

interface Cached {
  mtimeMs: number;
  size: number;
  rules: string[];
}
const cache = new Map<string, Cached>();

/** `host:` allow rules from the person's own permissions.yaml, cached by mtime and size; never throws. */
export function readUserHostAllow(
  file = path.join(getContinueGlobalPath(), "permissions.yaml"),
): string[] {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.rules;
    }
    const root = YAML.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    ) as { allow?: unknown } | null;
    const rules = hostAllowRules(root?.allow);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
    return rules;
  } catch {
    cache.delete(file);
    return [];
  }
}
