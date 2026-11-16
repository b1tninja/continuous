import {
  WEB_USER_AGENT_BUILTIN_PRESETS,
  type WebUserAgent,
} from "@continuedev/config-yaml";
import presetsFile from "./userAgentPresets.json";

/**
 * The User-Agent choices for `web.userAgent` (plans/research/web-fetch-deep-dive.md,
 * section 3.4, as decided by the owner on 2026-11-15). Building the header and
 * sending it is WB17; this module only knows the choices and their strings.
 *
 * Browser presets live only in userAgentPresets.json, refreshed by a
 * maintainer with scripts/update-ua-presets.mjs once per release. Nothing
 * fetches them at run time.
 */

/** The page a site operator reads to learn what the agent is (UA-10). */
export const WEB_AGENT_INFO_URL =
  "https://github.com/b1tninja/continuous/blob/main/docs/web-agent.md";

/** Product tokens, also the `robots.txt` tokens (RFC 9309 section 2.2.1: letters and hyphens only). */
export const USER_PRODUCT_TOKEN = "Continuous-User";
export const CRAWLER_PRODUCT_TOKEN = "Continuous-Crawler";

/** `generic-agent`: says it is an automated client and names no product. */
export const GENERIC_AGENT_USER_AGENT = "Mozilla/5.0 (compatible)";

export interface UserAgentPreset {
  id: string;
  label: string;
  userAgent: string;
}

export interface UserAgentPresetsFile {
  checkedAt: string;
  presets: UserAgentPreset[];
}

export const USER_AGENT_PRESETS_FILE = presetsFile as UserAgentPresetsFile;

/** The browser presets, in file order. */
export const BROWSER_USER_AGENT_PRESETS: readonly UserAgentPreset[] =
  USER_AGENT_PRESETS_FILE.presets;

const BUILTIN: readonly string[] = WEB_USER_AGENT_BUILTIN_PRESETS;

/** True for `continuous`, `generic-agent`, `custom` and every browser preset id. */
export function isKnownUserAgentPreset(id: string): boolean {
  return (
    BUILTIN.includes(id) || BROWSER_USER_AGENT_PRESETS.some((p) => p.id === id)
  );
}

/** `2.15.3` -> `2.15`; anything unparsable gives `0.0`, never a longer string. */
export function majorMinor(version: string | undefined): string {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  return m ? `${m[1]}.${m[2]}` : "0.0";
}

/**
 * `user`: a fetch made for the person (UA-1). `crawler`: the docs crawler
 * (UA-2). `search`: the person's own search provider, which gets the product
 * token without the info URL (UA-3): the person chose it, so it needs no page
 * explaining what the agent is.
 */
export type UserAgentPurpose = "user" | "crawler" | "search";

/**
 * The header value for a setting, or `""` for none. An unknown preset falls
 * back to `continuous`. Never includes the OS, the IDE, a patch version or
 * an id (UA-4), unless the person chose a browser preset or a custom string.
 */
export function userAgentFor(
  setting: WebUserAgent | undefined,
  options: { purpose: UserAgentPurpose; version: string | undefined },
): string {
  const preset = setting?.preset ?? "continuous";
  if (preset === "custom") return setting?.custom ?? "";
  if (preset === "generic-agent") return GENERIC_AGENT_USER_AGENT;
  const browser = BROWSER_USER_AGENT_PRESETS.find((p) => p.id === preset);
  if (browser) return browser.userAgent;
  const token =
    options.purpose === "crawler" ? CRAWLER_PRODUCT_TOKEN : USER_PRODUCT_TOKEN;
  const product = `${token}/${majorMinor(options.version)}`;
  return options.purpose === "search"
    ? product
    : `${product} (+${WEB_AGENT_INFO_URL})`;
}
