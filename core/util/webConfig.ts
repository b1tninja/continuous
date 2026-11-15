import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  sanitizeWebConfig,
  WEB_CEILINGS,
  WEB_DEFAULTS,
  WEB_ROBOTS_STRICTNESS,
  type WebConfig,
  type WebHostOverride,
  type WebReputationOnHit,
  type WebReputationProvider,
  type WebRobotsMode,
  type WebUserAgent,
} from "@continuedev/config-yaml";
import { isKnownUserAgentPreset } from "../web/userAgent";
import { getContinueGlobalPath } from "./paths";

/**
 * The `web:` settings in force, for every module that fetches a web page
 * (plans/research/web-fetch-deep-dive.md, section 8). Read `getWebConfig()`.
 *
 * Two sources, as for `terminal:` (core/util/terminalEnvironment.ts):
 *
 * - the person's own config.yaml, read directly from disk. Only it may set the
 *   identity and credential keys (`userAgent`, `acceptLanguage`, `hosts`,
 *   `reputation.providers`, `crawler.contact`, `search`) or loosen a safety
 *   setting (`robots: ignore`, `spotlight: false`, a higher limit);
 * - the loaded config (an assistant, the hub, a project folder), passed in by
 *   the loader through `applyWebConfig`. It may only tighten. Anything else it
 *   sets is ignored with one notice per key.
 *
 * The old spellings are still read, as aliases with a lower precedence than
 * the `web:` key: `toolPermissions.auto.environment.fetchMaxBytes` and
 * `fetchTimeoutSeconds` (personal config), CONTINUOUS_SPOTLIGHT_UNTRUSTED,
 * CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH, CONTINUOUS_WEB_SEARCH_URL and
 * CONTINUOUS_WEB_SEARCH_KEY. A deprecation notice is given once per process,
 * and only for an alias whose `web:` key is already honoured: telling the
 * person to move to a key nothing reads yet would be wrong.
 */

export type WebSettingSource =
  "default" | "user-config" | "legacy-key" | "env" | "assistant-config";

export interface ResolvedWebLimits {
  maxBytes: number;
  timeoutSeconds: number;
  maxRedirects: number;
  perHostPerMinute: number;
  modelChars: number;
}

export interface ResolvedWebConfig {
  /** `false`: the agent makes no web fetch. Any config may turn it off; only the person's own turns it on. */
  enabled: boolean;
  /** Reserved for the web policy area (follow-up); passed through from the person's config, read by nothing yet. */
  policy: unknown;
  /** The preset (core/web/userAgent.ts turns it into the header value). */
  userAgent: WebUserAgent;
  /** `""` sends no `Accept-Language`. */
  acceptLanguage: string;
  requireHttps: boolean;
  robots: WebRobotsMode;
  spotlight: boolean;
  limits: ResolvedWebLimits;
  cache: { minutes: number };
  /** Per-host overrides by pattern (`host:` rule syntax), from the personal config only. */
  hosts: Readonly<Record<string, WebHostOverride>>;
  reputation: {
    onHit: WebReputationOnHit;
    /** Empty means no lookup is ever made. */
    providers: readonly WebReputationProvider[];
  };
  crawler: { contact: string; concurrencyPerHost: number; minDelayMs: number };
  search: { provider?: string; url?: string; apiKey?: string };
  /** Where each setting that is not the default came from, by dot path under `web.`. */
  sources: Readonly<Record<string, WebSettingSource>>;
}

export interface WebDeprecation {
  /** The old key or environment variable. */
  key: string;
  /** The `web:` key that replaces it. */
  replacement: string;
  message: string;
}

export interface WebConfigInputs {
  /** `web:` from the person's own config.yaml, as parsed. */
  user?: unknown;
  /** `toolPermissions.auto.environment` from the person's own config.yaml. */
  userLegacy?: unknown;
  /** `web:` from the loaded config (assistant, hub, project folder). */
  other?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface WebConfigResolution {
  config: ResolvedWebConfig;
  /** One sentence per value that was ignored or held to a ceiling. */
  notices: string[];
  /** Old keys and variables that were read. Every one, every time: `applyWebConfig` gives each once. */
  deprecations: WebDeprecation[];
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A whole number of at least 1 from YAML. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

/** A whole number of at least 1 from an environment variable. */
function positiveIntText(value: string | undefined): number | undefined {
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
    const n = Number(value);
    return n >= 1 ? n : undefined;
  }
  return undefined;
}

const TEMPLATE = /\$\{\{/;

/**
 * A personal value whose strings are `${{ secrets.NAME }}` templates is read
 * from disk unrendered. Where the loaded config, which the loader rendered,
 * has a plain string at the same place, that string is the rendered value.
 * The personal file still decides which keys exist and every literal value.
 */
function fillTemplates(personal: unknown, rendered: unknown): unknown {
  if (typeof personal === "string") {
    return TEMPLATE.test(personal) &&
      typeof rendered === "string" &&
      !TEMPLATE.test(rendered)
      ? rendered
      : personal;
  }
  if (Array.isArray(personal)) {
    return personal.map((v, i) =>
      fillTemplates(v, Array.isArray(rendered) ? rendered[i] : undefined),
    );
  }
  if (isRecord(personal)) {
    const r = isRecord(rendered) ? rendered : {};
    return Object.fromEntries(
      Object.entries(personal).map(([k, v]) => [k, fillTemplates(v, r[k])]),
    );
  }
  return personal;
}

/** The `web:` keys only the person's own config.yaml may set. */
const PERSONAL_ONLY = [
  "policy",
  "userAgent",
  "acceptLanguage",
  "hosts",
  "reputation.providers",
  "crawler.contact",
  "search",
] as const;

function at(obj: WebConfig | undefined, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function ignoredNotice(key: string, value: unknown, why: string): string {
  const shown =
    typeof value === "string" || typeof value === "number"
      ? `: ${JSON.stringify(value)}`
      : "";
  return `web.${key}${shown} in the assistant or project configuration was ignored: ${why}`;
}

const PERSONAL_WHY =
  "it is taken from your own config.yaml only, because it decides what the agent sends to every site.";
const LOOSEN_WHY =
  "a configuration that is not your own may only tighten web settings; set it in your own config.yaml to use it.";

/**
 * Merge the person's settings, the old spellings and the loaded config's
 * `web:` into the settings in force. Pure.
 */
export function resolveWebConfig(
  inputs: WebConfigInputs = {},
): WebConfigResolution {
  const env = inputs.env ?? {};
  const notices: string[] = [];
  const deprecations: WebDeprecation[] = [];
  const sources: Record<string, WebSettingSource> = {};

  const userParsed = sanitizeWebConfig(inputs.user);
  const otherParsed = sanitizeWebConfig(inputs.other);
  for (const key of userParsed.dropped) {
    notices.push(
      `${key} in your config.yaml is not a valid value and was ignored.`,
    );
  }
  const other = otherParsed.value;
  const user = fillTemplates(userParsed.value, other) as WebConfig | undefined;
  const legacy = isRecord(inputs.userLegacy) ? inputs.userLegacy : {};

  const deprecate = (key: string, replacement: string, both: boolean) => {
    deprecations.push({
      key,
      replacement,
      message: both
        ? `${key} is deprecated and was not used, because ${replacement} is also set in your config.yaml. Remove ${key}.`
        : `${key} is deprecated: use ${replacement} in your config.yaml instead. The old key still works for now.`,
    });
  };

  // 1. The person's own values, then the old spellings, then the default.
  const personal = <T>(
    key: string,
    own: T | undefined,
    fallback: T,
    alias?: {
      value: T | undefined;
      key: string;
      source: WebSettingSource;
      announce: boolean;
    },
  ): T => {
    if (own !== undefined) {
      sources[key] = "user-config";
      if (alias?.value !== undefined && alias.announce) {
        deprecate(alias.key, `web.${key}`, true);
      }
      return own;
    }
    if (alias?.value !== undefined) {
      sources[key] = alias.source;
      if (alias.announce) deprecate(alias.key, `web.${key}`, false);
      return alias.value;
    }
    return fallback;
  };

  const limits: Writable<ResolvedWebLimits> = {
    // The byte cap and deadline are read by @url and the fetch tool through
    // readUserFetchLimits, so the new keys work and the old ones are announced.
    maxBytes: personal(
      "limits.maxBytes",
      user?.limits?.maxBytes,
      WEB_DEFAULTS.limits.maxBytes,
      {
        value: positiveInt(legacy.fetchMaxBytes),
        key: "toolPermissions.auto.environment.fetchMaxBytes",
        source: "legacy-key",
        announce: true,
      },
    ),
    timeoutSeconds: personal(
      "limits.timeoutSeconds",
      user?.limits?.timeoutSeconds,
      WEB_DEFAULTS.limits.timeoutSeconds,
      {
        value: positiveInt(legacy.fetchTimeoutSeconds),
        key: "toolPermissions.auto.environment.fetchTimeoutSeconds",
        source: "legacy-key",
        announce: true,
      },
    ),
    maxRedirects: personal(
      "limits.maxRedirects",
      user?.limits?.maxRedirects,
      WEB_DEFAULTS.limits.maxRedirects,
    ),
    perHostPerMinute: personal(
      "limits.perHostPerMinute",
      user?.limits?.perHostPerMinute,
      WEB_DEFAULTS.limits.perHostPerMinute,
    ),
    // The CLI's Fetch tool still reads the variable itself: not announced yet.
    modelChars: personal(
      "limits.modelChars",
      user?.limits?.modelChars,
      WEB_DEFAULTS.limits.modelChars,
      {
        value: positiveIntText(env.CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH),
        key: "CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH",
        source: "env",
        announce: false,
      },
    ),
  };

  // The ceilings bind every source, the person's own included.
  const ceilings: [keyof typeof WEB_CEILINGS, string][] = [
    ["maxBytes", "64 MiB"],
    ["timeoutSeconds", "300 seconds"],
    ["maxRedirects", "10"],
  ];
  for (const [key, shown] of ceilings) {
    if (limits[key] > WEB_CEILINGS[key]) {
      notices.push(
        `web.limits.${key}: ${limits[key]} is above the ceiling of ${shown}, so the ceiling is used.`,
      );
      limits[key] = WEB_CEILINGS[key];
    }
  }

  const config: Writable<ResolvedWebConfig> = {
    enabled: personal("enabled", user?.enabled, WEB_DEFAULTS.enabled),
    policy: personal("policy", user?.policy, undefined),
    userAgent: personal(
      "userAgent",
      knownPreset(user?.userAgent, "userAgent", notices),
      { ...WEB_DEFAULTS.userAgent },
    ),
    acceptLanguage: personal(
      "acceptLanguage",
      user?.acceptLanguage,
      WEB_DEFAULTS.acceptLanguage,
    ),
    requireHttps: personal(
      "requireHttps",
      user?.requireHttps,
      WEB_DEFAULTS.requireHttps,
    ),
    robots: personal("robots", user?.robots, WEB_DEFAULTS.robots),
    // fetch_url_content still reads its own switch: not announced yet.
    spotlight: personal("spotlight", user?.spotlight, WEB_DEFAULTS.spotlight, {
      value: env.CONTINUOUS_SPOTLIGHT_UNTRUSTED === "1" ? true : undefined,
      key: "CONTINUOUS_SPOTLIGHT_UNTRUSTED",
      source: "env",
      announce: false,
    }),
    limits,
    cache: {
      minutes: personal(
        "cache.minutes",
        user?.cache?.minutes,
        WEB_DEFAULTS.cache.minutes,
      ),
    },
    hosts: personal("hosts", knownHostPresets(user?.hosts, notices), {}),
    reputation: {
      onHit: personal(
        "reputation.onHit",
        user?.reputation?.onHit,
        WEB_DEFAULTS.reputation.onHit,
      ),
      providers: personal(
        "reputation.providers",
        user?.reputation?.providers,
        [],
      ),
    },
    crawler: {
      contact: personal("crawler.contact", user?.crawler?.contact, ""),
      concurrencyPerHost: personal(
        "crawler.concurrencyPerHost",
        user?.crawler?.concurrencyPerHost,
        WEB_DEFAULTS.crawler.concurrencyPerHost,
      ),
      minDelayMs: personal(
        "crawler.minDelayMs",
        user?.crawler?.minDelayMs,
        WEB_DEFAULTS.crawler.minDelayMs,
      ),
    },
    // The search backend still reads the variables itself (WB1): not announced yet.
    search: {
      ...(personalSearch(user, env, sources) ?? {}),
    },
    sources,
  };

  // 2. The loaded config may only tighten.
  if (other) tighten(config, user, other, notices);

  return { config, notices, deprecations };
}

/** A preset id that is neither built in nor in the presets file is dropped. */
function knownPreset(
  setting: WebUserAgent | undefined,
  key: string,
  notices: string[],
): WebUserAgent | undefined {
  if (!setting || isKnownUserAgentPreset(setting.preset)) return setting;
  notices.push(
    `web.${key}.preset: ${JSON.stringify(setting.preset)} is not a known User-Agent preset, so the default is used.`,
  );
  return undefined;
}

function knownHostPresets(
  hosts: Record<string, WebHostOverride> | undefined,
  notices: string[],
): Record<string, WebHostOverride> | undefined {
  if (!hosts) return undefined;
  return Object.fromEntries(
    Object.entries(hosts).map(([pattern, o]) => {
      const userAgent = knownPreset(
        o.userAgent,
        `hosts[${JSON.stringify(pattern)}].userAgent`,
        notices,
      );
      const { userAgent: _dropped, ...rest } = o;
      return [pattern, userAgent ? { ...rest, userAgent } : rest];
    }),
  );
}

function personalSearch(
  user: WebConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
  sources: Record<string, WebSettingSource>,
): ResolvedWebConfig["search"] | undefined {
  if (user?.search) {
    sources.search = "user-config";
    return { ...user.search };
  }
  const url = env.CONTINUOUS_WEB_SEARCH_URL?.trim();
  const apiKey = env.CONTINUOUS_WEB_SEARCH_KEY?.trim();
  if (!url && !apiKey) return undefined;
  sources.search = "env";
  return { ...(url ? { url } : {}), ...(apiKey ? { apiKey } : {}) };
}

function tighten(
  config: Writable<ResolvedWebConfig>,
  user: WebConfig | undefined,
  other: WebConfig,
  notices: string[],
): void {
  const sources = config.sources as Record<string, WebSettingSource>;
  const fromOther = (key: string) => {
    sources[key] = "assistant-config";
  };

  for (const key of PERSONAL_ONLY) {
    const value = at(other, key);
    if (value === undefined || sameValue(value, at(user, key))) continue;
    notices.push(ignoredNotice(key, undefined, PERSONAL_WHY));
  }

  if (other.enabled !== undefined && other.enabled !== config.enabled) {
    if (other.enabled) {
      notices.push(ignoredNotice("enabled", undefined, LOOSEN_WHY));
    } else {
      config.enabled = false;
      fromOther("enabled");
    }
  }

  const flag = (
    key: "requireHttps" | "spotlight",
    value: boolean | undefined,
  ) => {
    if (value === undefined || value === config[key]) return;
    if (value) {
      config[key] = true;
      fromOther(key);
    } else notices.push(ignoredNotice(key, undefined, LOOSEN_WHY));
  };
  flag("requireHttps", other.requireHttps);
  flag("spotlight", other.spotlight);

  if (other.robots && other.robots !== config.robots) {
    const stricter =
      WEB_ROBOTS_STRICTNESS.indexOf(other.robots) <
      WEB_ROBOTS_STRICTNESS.indexOf(config.robots);
    if (stricter) {
      config.robots = other.robots;
      fromOther("robots");
    } else notices.push(ignoredNotice("robots", other.robots, LOOSEN_WHY));
  }

  const lower = (
    key: string,
    value: number | undefined,
    get: () => number,
    set: (n: number) => void,
  ) => {
    if (value === undefined || value === get()) return;
    if (value < get()) {
      set(value);
      fromOther(key);
    } else notices.push(ignoredNotice(key, value, LOOSEN_WHY));
  };
  for (const key of Object.keys(config.limits) as (keyof ResolvedWebLimits)[]) {
    lower(
      `limits.${key}`,
      other.limits?.[key],
      () => config.limits[key],
      (n) => (config.limits[key] = n),
    );
  }
  lower(
    "cache.minutes",
    other.cache?.minutes,
    () => config.cache.minutes,
    (n) => (config.cache.minutes = n),
  );
  lower(
    "crawler.concurrencyPerHost",
    other.crawler?.concurrencyPerHost,
    () => config.crawler.concurrencyPerHost,
    (n) => (config.crawler.concurrencyPerHost = n),
  );
  // A longer delay is the tighter one, so compare the other way round
  lower(
    "crawler.minDelayMs",
    other.crawler?.minDelayMs === undefined
      ? undefined
      : -other.crawler.minDelayMs,
    () => -config.crawler.minDelayMs,
    (n) => (config.crawler.minDelayMs = -n),
  );

  const onHit = other.reputation?.onHit;
  if (onHit && onHit !== config.reputation.onHit) {
    if (onHit === "refuse") {
      config.reputation.onHit = "refuse";
      fromOther("reputation.onHit");
    } else {
      notices.push(ignoredNotice("reputation.onHit", onHit, LOOSEN_WHY));
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the person's file, and the settings in force for this process.

interface UserWebInputs {
  user: unknown;
  userLegacy: unknown;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  value: UserWebInputs;
}

const fileCache = new Map<string, CachedFile>();

let userConfigFileForTests: string | undefined;

function defaultUserConfigFile(): string {
  return (
    userConfigFileForTests ?? path.join(getContinueGlobalPath(), "config.yaml")
  );
}

/**
 * `web:` and the old `toolPermissions.auto.environment` keys from the
 * person's own config.yaml, cached by modification time and size. A missing
 * or unreadable file is no settings, never a throw.
 */
export function readUserWebInputs(
  file = defaultUserConfigFile(),
): UserWebInputs {
  try {
    const stat = fs.statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const root = YAML.parse(
      fs.readFileSync(file, "utf8").replace(/^﻿/, ""),
    ) as any;
    const value: UserWebInputs = {
      user: root?.web,
      userLegacy: root?.toolPermissions?.auto?.environment,
    };
    fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    fileCache.delete(file);
    return { user: undefined, userLegacy: undefined };
  }
}

const ENV_NAMES = [
  "CONTINUOUS_SPOTLIGHT_UNTRUSTED",
  "CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH",
  "CONTINUOUS_WEB_SEARCH_URL",
  "CONTINUOUS_WEB_SEARCH_KEY",
];

let loadedOther: unknown;
let memo:
  | {
      inputs: UserWebInputs;
      other: unknown;
      envKey: string;
      resolution: WebConfigResolution;
    }
  | undefined;
const announced = new Set<string>();

function currentResolution(
  env: Readonly<Record<string, string | undefined>>,
): WebConfigResolution {
  const inputs = readUserWebInputs();
  const envKey = JSON.stringify(ENV_NAMES.map((n) => env[n] ?? null));
  if (
    memo &&
    memo.inputs === inputs &&
    memo.other === loadedOther &&
    memo.envKey === envKey
  ) {
    return memo.resolution;
  }
  const resolution = resolveWebConfig({ ...inputs, other: loadedOther, env });
  memo = { inputs, other: loadedOther, envKey, resolution };
  return resolution;
}

/**
 * The web settings in force: the person's config.yaml (re-read when it
 * changes), the old spellings, and whatever the last loaded config tightened.
 * Before any config is loaded, the person's file and the environment alone.
 */
export function getWebConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedWebConfig {
  return currentResolution(env).config;
}

/**
 * Called by a config loader with the loaded config's `web:` value. Returns
 * the notices for the values it ignored (every load, like other trust
 * notices) and the deprecation lines not given before in this process.
 */
export function applyWebConfig(
  other: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { notices: string[]; deprecations: string[] } {
  loadedOther = other;
  const resolution = currentResolution(env);
  return {
    notices: resolution.notices,
    deprecations: takeNewDeprecations(resolution.deprecations),
  };
}

/** The deprecation lines not yet given in this process; each is given once. */
export function takeNewDeprecations(list: WebDeprecation[]): string[] {
  const fresh: string[] = [];
  for (const d of list) {
    if (announced.has(d.message)) continue;
    announced.add(d.message);
    fresh.push(d.message);
  }
  return fresh;
}

/**
 * For tests: forget the loaded config, the file cache and what was announced,
 * and read the person's config from `userConfigFile` (default: the real one).
 */
export function resetWebConfigForTests(userConfigFile?: string): void {
  userConfigFileForTests = userConfigFile;
  loadedOther = undefined;
  memo = undefined;
  fileCache.clear();
  announced.clear();
}
