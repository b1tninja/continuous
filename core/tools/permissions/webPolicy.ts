import type { ToolPolicy } from "@continuedev/terminal-security";
import {
  cloudMetadataReason,
  cloudMetadataRefusal,
  secretKindsInUrl,
} from "../../util/fetchUrlSafety";
import { hostTrusted } from "./askProtections";
import { normalizeHost } from "./destinations";
import type { EvaluateInput, ToolPolicyResult } from "./evaluate";
import {
  parseWebLevel,
  POLICY_LEVELS,
  type PolicyLevels,
  type WebLevel,
} from "./policy";
import type { WebGrantView } from "./webGrants";
import { hostRuleMatches } from "./webHostRules";

/**
 * The Web area (plans/research/web-fetch-large-pages-and-policy.md, section 8;
 * ROADMAP row WB45): who decides a web call that the person's rules leave
 * open. The sixth area beside Context use, Tool use, File edits, Plan edits
 * and Questions, with two levels of its own, Off and Listed.
 *
 * What is in the area: `fetch_url_content` (CLI `Fetch`), `search_web`, and
 * later `read_web_content`, provider-native search and browser MCP tools.
 * `@url`, the docs crawler and the Browser panel are person-directed and are
 * governed by `web.enabled` only.
 *
 * The decision order is section 8.3's, as `decideWebCall` below. The checks
 * that live inside the fetch (scheme, userinfo, a credential in the URL, a
 * cloud metadata address, public-to-private redirects, the byte cap and
 * deadline, cookie isolation) bind at every level, IDGAF included; so do the
 * person's own `floor:` rules and `web.robots: respect`. IDGAF never asks.
 */

export const WEB_AREA_LABEL = "Web";

/** One line per level for the dropdown and `/policy` (section 8.2). */
export const WEB_LEVEL_DESCRIPTIONS: Record<WebLevel, string> = {
  off: "No web tools: the agent cannot fetch or search.",
  manual: "Asks before every fetch and search.",
  cautious: "Asks before a new domain; runs domains you allowed.",
  listed: "Only domains you allowed. Never asks; everything else is refused.",
  automatic: "As Cautious, and a reviewer model decides new domains.",
  permissive: "Fetches anything no rule stops.",
  idgaf:
    "Fetches anything. Every rule is ignored; built-in fetch safety (no credentials, no cloud metadata, no redirect into your network) still applies.",
};

export function webLevelLabel(level: WebLevel): string {
  if (level === "idgaf") return "IDGAF";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

// ---------------------------------------------------------------------------
// Which calls are web calls

/** Tool names in the Web area, in the IDE's and the CLI's spellings. */
const WEB_TOOL_NAMES = new Set<string>([
  "fetch_url_content",
  "search_web",
  "read_web_content",
  "Fetch",
  "SearchWeb",
  "ReadWebContent",
  // Rule names
  "fetchUrl",
  "searchWeb",
]);

const SEARCH_TOOL_NAMES = new Set<string>(["search_web", "SearchWeb"]);

/** True for a tool the Web area governs. */
export function isWebToolName(name: string): boolean {
  return WEB_TOOL_NAMES.has(name);
}

/**
 * The tool list without the agent's web tools, when Web is Off (by
 * `levels.web: off` or `web.enabled: false`). A call that still arrives (a
 * warm prompt cache, C88) is refused by `applyWebArea`.
 */
export function withholdWebTools<T extends { function: { name: string } }>(
  tools: T[],
  off: boolean,
): T[] {
  return off ? tools.filter((t) => !isWebToolName(t.function.name)) : tools;
}

// ---------------------------------------------------------------------------
// The level in force

/** Where the Web level in force came from. */
export type WebLevelSource =
  /** `web.enabled: false` in some config.yaml: Off, locked */
  | "web.enabled"
  /** `levels.web` was set */
  | "levels.web"
  /** `web.policy`, WB27's placeholder, read as `levels.web` */
  | "web.policy"
  /** Unset: Web follows Tool use */
  | "tools";

export interface EffectiveWebLevel {
  level: WebLevel;
  source: WebLevelSource;
}

export interface WebLevelOptions {
  /** `web.enabled` as resolved (core/util/webConfig.ts); absent is on. */
  enabled?: boolean;
  /** `web.policy` from the person's own config.yaml, if it holds a level. */
  policyAlias?: unknown;
}

/**
 * The Web level in force. `web.enabled: false` from any config is Off;
 * otherwise `levels.web`; otherwise `web.policy` if it names a level;
 * otherwise Tool use's level (the five shared levels map one to one), so no
 * setting saved before Web existed changes meaning. No levels at all is
 * Cautious, as for every area.
 */
export function effectiveWebLevel(
  levels: Partial<PolicyLevels> | undefined,
  options: WebLevelOptions = {},
): EffectiveWebLevel {
  if (options.enabled === false) return { level: "off", source: "web.enabled" };
  if (levels?.web) return { level: levels.web, source: "levels.web" };
  const alias = webPolicyAlias(options.policyAlias);
  if (alias.level) return { level: alias.level, source: "web.policy" };
  return { level: levels?.tools ?? "cautious", source: "tools" };
}

/**
 * WB27's placeholder `web.policy`, read as `levels.web` when it holds a level
 * (never IDGAF, which is for one session only), with the notice that names
 * the new home. Anything else is ignored.
 */
export function webPolicyAlias(raw: unknown): {
  level?: WebLevel;
  notice?: string;
} {
  if (raw === undefined || raw === null) return {};
  const level = parseWebLevel(raw);
  if (!level || level === "idgaf") {
    return {
      notice:
        "web.policy in your config.yaml is not a Web level and was ignored. Set levels.web in permissions.yaml instead.",
    };
  }
  return {
    level,
    notice:
      "web.policy is deprecated: set levels.web in permissions.yaml instead. The old key still works for now.",
  };
}

/** The Web level written in permissions.yaml, or a notice when it cannot be used. */
export function storedWebLevel(raw: unknown): {
  level?: WebLevel;
  notice?: string;
} {
  if (raw === undefined) return {};
  const level = parseWebLevel(raw);
  if (level === "idgaf") {
    return {
      notice:
        "levels.web: idgaf is for one session only, so Web follows Tool use.",
    };
  }
  if (!level) {
    return {
      notice: `levels.web: "${String(raw)}" is not a level, so Web follows Tool use.`,
    };
  }
  return { level };
}

/** --safe: Web no looser than its default (Cautious). Off, Listed and Manual are kept. */
export function capWebAtDefault(
  level: WebLevel | undefined,
): WebLevel | undefined {
  if (level === undefined) return undefined;
  if (level === "off" || level === "listed") return level;
  return POLICY_LEVELS.indexOf(level) > POLICY_LEVELS.indexOf("cautious")
    ? "cautious"
    : level;
}

/**
 * The Web part of the headless start-up line (CO2). Nobody can be asked, so
 * every ask is refused: Cautious then runs only allowed domains, as Listed.
 */
export function webHeadlessLine(
  web: EffectiveWebLevel,
  options: {
    /**
     * The terminal agent's one-release transition: headless Fetch to
     * a public host still runs at Cautious, from its default list.
     */
    transition?: boolean;
  } = {},
): string {
  const name = `${WEB_AREA_LABEL} ${webLevelLabel(web.level)}`;
  switch (web.level) {
    case "off":
      return web.source === "web.enabled"
        ? `${name} (config.yaml: web.enabled)`
        : name;
    case "manual":
      return `${name} (unattended: every fetch refused)`;
    case "cautious":
      return options.transition
        ? `${name} (unattended: public hosts still run in this release; from 2.38 only allowed domains)`
        : `${name} (unattended: only allowed domains)`;
    case "automatic":
      return `${name} (unattended: the reviewer decides; unsure is refused)`;
    default:
      return name;
  }
}

// ---------------------------------------------------------------------------
// The decision for one web call (section 8.3)

/** A protection that asks below IDGAF (step 8). */
export type WebProtection =
  "private" | "confusable" | "robots" | "reputation" | "guard";

export interface WebCallFacts {
  level: WebLevel;
  /** Where the level came from, for the Off text. */
  levelSource?: WebLevelSource;
  /** The host, for the texts. */
  host?: string;
  /** Step 4: a fetch-internal check that refuses (scheme, userinfo, credential, metadata). */
  hardRefusal?: string;
  /** Step 5: a `floor:` deny rule matched, as written. */
  floorRule?: string;
  /** Step 5: `web.robots: respect` and robots.txt disallows the URL. */
  robotsRespectDisallow?: boolean;
  /** Step 7: a deny rule (or another refusal below IDGAF), its reason. */
  denied?: string;
  /** Step 7: the host is blocked for this session. */
  sessionBlock?: boolean;
  /** Step 8: a protection asks, and why. */
  protection?: { kind: WebProtection; reason: string };
  /** Step 9: an ask rule matched, its reason. */
  askRule?: string;
  /** Step 11: an allow rule, `trustedDomains` or the configured search backend covers the host. */
  hostAllowed?: { reason: string };
  /** The tool's own setting runs it (the person set the tool to run without asking). */
  toolSettingRuns?: boolean;
  /** Step 11: the host was allowed for this session (Allow, Once). */
  sessionGrant?: boolean;
  /** Step 11: the exact URL is in one of the person's messages. */
  urlInUserMessage?: boolean;
  /** Nobody can be asked (headless, a background agent): an ask is refused. */
  unattended?: boolean;
}

export type WebOutcome =
  /** The tool is not offered: Web is Off */
  | "withheld"
  | "refused"
  | "ask"
  /** Automatic: the reviewer model decides; unsure asks */
  | "review"
  | "run";

export interface WebDecision {
  outcome: WebOutcome;
  /** The step of section 8.3 that decided. */
  step: number;
  /** One sentence for the person and the model. */
  reason: string;
  /** IDGAF ran past this; for the audit trail. */
  recorded?: string;
}

const UNATTENDED =
  "Nobody can be asked in an unattended run, so it was refused.";

function hostText(facts: WebCallFacts): string {
  return facts.host ? facts.host : "this host";
}

/** An ask, or a refusal when nobody can be asked. */
function askOrRefuse(
  facts: WebCallFacts,
  step: number,
  reason: string,
): WebDecision {
  return facts.unattended
    ? { outcome: "refused", step, reason: `${reason} ${UNATTENDED}` }
    : { outcome: "ask", step, reason };
}

/** What IDGAF would have stopped at, below it. */
function idgafRecorded(facts: WebCallFacts): string | undefined {
  const parts = [
    facts.denied,
    facts.sessionBlock ? `${hostText(facts)} is blocked for this session` : "",
    facts.protection?.reason,
    facts.askRule,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Section 8.3, steps 2 to 12, for one web call. Pure: every fact is given.
 * Step 1 (an organisation ceiling) is not built yet; step 3 (hooks) runs
 * before the permission layer.
 */
export function decideWebCall(facts: WebCallFacts): WebDecision {
  const { level } = facts;
  const host = hostText(facts);

  // 2. Off: the tool is not offered
  if (level === "off") {
    return {
      outcome: "withheld",
      step: 2,
      reason:
        facts.levelSource === "web.enabled"
          ? "Refused: web access is off in config.yaml (web.enabled: false), so no web fetch or search is made. Do not retry it."
          : "Refused: Web is Off, so the agent has no web tools in this session. Do not retry it; the person can change the Web level.",
    };
  }
  // 4. The fetch's own hard checks, at every level
  if (facts.hardRefusal) {
    return { outcome: "refused", step: 4, reason: facts.hardRefusal };
  }
  // 5. The person's own hard lines bind at IDGAF too
  if (facts.floorRule) {
    return {
      outcome: "refused",
      step: 5,
      reason: `Blocked by your floor rule ${facts.floorRule}, which binds at every level. Do not retry it unchanged.`,
    };
  }
  if (facts.robotsRespectDisallow) {
    return {
      outcome: "refused",
      step: 5,
      reason: `Refused: robots.txt on ${host} disallows this URL, and your web.robots is respect. Do not retry it.`,
    };
  }
  // 6. IDGAF: run, and record what it ran past
  if (level === "idgaf") {
    const recorded = idgafRecorded(facts);
    return {
      outcome: "run",
      step: 6,
      reason: "Allowed: Web is set to IDGAF.",
      ...(recorded ? { recorded } : {}),
    };
  }
  // 7. A deny rule or a session block
  if (facts.denied) {
    return { outcome: "refused", step: 7, reason: facts.denied };
  }
  if (facts.sessionBlock) {
    return {
      outcome: "refused",
      step: 7,
      reason: `Refused: you blocked ${host} for this session. Do not retry it.`,
    };
  }
  // 8. Protections: ask, or refuse at Listed and unattended
  if (facts.protection) {
    const why = facts.protection.reason;
    if (level === "listed") {
      return {
        outcome: "refused",
        step: 8,
        reason: `Refused: ${why}. Web is Listed, which never asks. Do not retry it unchanged.`,
      };
    }
    return askOrRefuse(
      facts,
      8,
      `${why}: this asks at Web ${webLevelLabel(level)}.`,
    );
  }
  // 9. An ask rule
  if (facts.askRule) {
    if (level === "listed") {
      return {
        outcome: "refused",
        step: 9,
        reason: `Refused: ${facts.askRule} Web is Listed, which never asks.`,
      };
    }
    return askOrRefuse(facts, 9, facts.askRule);
  }
  // 10. Manual asks every fetch
  if (level === "manual") {
    return askOrRefuse(
      facts,
      10,
      `Web is Manual, which asks before every fetch and search (${host}).`,
    );
  }
  // 11. A host the person allowed
  if (facts.hostAllowed) {
    return { outcome: "run", step: 11, reason: facts.hostAllowed.reason };
  }
  if (level !== "listed") {
    if (facts.sessionGrant) {
      return {
        outcome: "run",
        step: 11,
        reason: `Allowed: you allowed ${host} for this session.`,
      };
    }
    if (facts.urlInUserMessage) {
      return {
        outcome: "run",
        step: 11,
        reason: "Allowed: you wrote this exact URL in your message.",
      };
    }
    if (facts.toolSettingRuns) {
      return {
        outcome: "run",
        step: 11,
        reason: "Allowed: the tool's own setting runs it without asking.",
      };
    }
  }
  // 12. The level decides
  switch (level) {
    case "cautious":
      return askOrRefuse(
        facts,
        12,
        `${host} is a new domain: Web is Cautious, which asks before a new domain.`,
      );
    case "listed":
      return {
        outcome: "refused",
        step: 12,
        reason: `Refused: ${host} is not one of the domains you allowed, and Web is Listed, which never asks. Do not retry it unchanged; the person can allow the domain.`,
      };
    case "automatic":
      return {
        outcome: "review",
        step: 12,
        reason: `${host} is a new domain: at Web Automatic the reviewer model decides.`,
      };
    case "permissive":
      return {
        outcome: "run",
        step: 12,
        reason: "Allowed: Web is Permissive and no rule stops it.",
      };
  }
}

/** What happens to a redirect hop, by level (sections 8.2 and 11.3, WB16). */
export type WebRedirectOutcome =
  | "follow"
  /** Followed; the page is labelled with the final URL */
  | "follow-labelled"
  | "ask"
  | "review"
  | "refused";

/**
 * A redirect to a host this fetch has not seen. The hard checks at the hop
 * (scheme, userinfo, credential, metadata, public-to-private) run inside the
 * fetch first (core/util/guardedFetch.ts), at every level. A hop to the start
 * host, or to a host an allow rule or a session grant covers, is followed.
 */
export function decideWebRedirect(
  level: WebLevel,
  hop: { hostSeen: boolean; unattended?: boolean },
): WebRedirectOutcome {
  if (level === "off") return "refused";
  if (hop.hostSeen) return "follow";
  switch (level) {
    case "manual":
    case "cautious":
      return hop.unattended ? "refused" : "ask";
    case "listed":
      return "refused";
    case "automatic":
      return "review";
    case "permissive":
    case "idgaf":
      return "follow-labelled";
  }
}

// ---------------------------------------------------------------------------
// The URL facts

/** The hard refusal for a URL, before any connection: scheme, userinfo, credential, metadata. */
export function urlHardRefusal(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Refused: only http and https URLs can be fetched (this one is ${url.protocol}). Do not retry it.`;
  }
  if (url.username || url.password) {
    return "Refused: the URL has a user name or password in it. Credentials are never sent in a URL. Do not retry it.";
  }
  const kinds = secretKindsInUrl(url);
  if (kinds.length) {
    return `Refused: the URL contains what looks like a credential (${kinds.join(", ")}). It was not fetched. Do not put secrets in a URL.`;
  }
  const metadata = cloudMetadataReason(url.hostname);
  if (metadata) return cloudMetadataRefusal(metadata);
  return undefined;
}

function hostOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const host = new URL(raw).hostname;
    return host ? normalizeHost(host) : undefined;
  } catch {
    return undefined;
  }
}

function canonicalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;

/** The URLs written in the person's messages, each in its canonical form. */
export function urlsInUserMessages(messages: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of messages) {
    for (const match of text.match(URL_IN_TEXT) ?? []) {
      // Punctuation that ends a sentence or closes a bracket is not the URL's
      const trimmed = match.replace(/[.,;:!?)\]}>]+$/, "");
      const url = canonicalUrl(trimmed);
      if (url) found.add(url);
    }
  }
  return [...found];
}

/** The exact URL is one the person wrote (WB6's user-origin flag). */
export function urlIsFromUser(
  raw: unknown,
  userUrls: readonly string[] | undefined,
): boolean {
  if (typeof raw !== "string" || !userUrls?.length) return false;
  const url = canonicalUrl(raw);
  return url !== undefined && userUrls.includes(url);
}

// ---------------------------------------------------------------------------
// The hook in the permission layer (evaluate.ts)

/** What a host gives the engine for a web call, besides the levels. */
export interface WebCallContext {
  /** `web.enabled` as resolved (core/util/webConfig.ts); absent is on. */
  enabled?: boolean;
  /** `web.policy` from the person's config.yaml, read as `levels.web` when it names a level. */
  policyAlias?: unknown;
  /** The session's grants and blocks (webGrants.ts). */
  grants?: WebGrantView;
  /** URLs in the person's own messages this session (urlsInUserMessages). */
  userUrls?: readonly string[];
  /**
   * `host:` allow rules from the person's own permissions.yaml (`allow:`
   * list) or `--allow host:<h>`: `host:example.com` is that host only,
   * `host:*.example.com` its subdomains only (whole labels, webHostRules.ts).
   */
  hostAllow?: readonly string[];
  /** Nobody can be asked: an ask is refused here rather than by the host. */
  unattended?: boolean;
}

/** The field `EvaluateInput` carries for the Web area. */
export interface WebEvaluateInput {
  web?: WebCallContext;
}

/**
 * Builds the context from the settings in force: `config` is
 * `getWebConfig()`, `userMessages` the person's messages this session.
 */
export function webCallContext(args: {
  config?: { enabled?: boolean; policy?: unknown };
  grants?: WebGrantView;
  userMessages?: readonly string[];
  unattended?: boolean;
  hostAllow?: readonly string[];
}): WebCallContext {
  return {
    ...(args.config?.enabled === false ? { enabled: false } : {}),
    ...(args.config?.policy === undefined
      ? {}
      : { policyAlias: args.config.policy }),
    ...(args.grants ? { grants: args.grants } : {}),
    ...(args.userMessages?.length
      ? { userUrls: urlsInUserMessages(args.userMessages) }
      : {}),
    ...(args.unattended ? { unattended: true } : {}),
    ...(args.hostAllow?.length ? { hostAllow: [...args.hostAllow] } : {}),
  };
}

const LEVEL_SOURCES = new Set<string | undefined>([
  "tool-setting",
  "default",
  "manual",
  "permissive",
  undefined,
]);

/**
 * The pipeline's protection, as the Web area names it. `ask-unknown-host`
 * (a host outside `trustedDomains`) is a "new domain" ask, which the person's
 * own session grant or the URL they wrote answers: `answered` drops it.
 */
function protectionOf(
  result: ToolPolicyResult,
  answered: boolean,
): WebCallFacts["protection"] | undefined {
  if (result.policy !== "allowedWithPermission") return undefined;
  if (result.source !== "protected-path") return undefined;
  if (result.protection === "unknown-host" && answered) return undefined;
  const reason = (result.reason ?? "a protection asks").replace(/\.$/, "");
  return {
    kind: result.protection === "private-url" ? "private" : "guard",
    reason,
  };
}

/** Facts from the IDGAF record: what the pipeline would have decided below IDGAF. */
function idgafFacts(result: ToolPolicyResult): Partial<WebCallFacts> {
  const o = result.idgafOverride;
  if (!o) return {};
  if (o.source === "floor" && o.rule) return { floorRule: o.rule };
  if (o.policy === "disabled") return { denied: o.reason ?? "a rule refuses" };
  if (o.source === "ask-rule") return { askRule: o.reason ?? "an ask rule" };
  if (o.source === "protected-path") {
    return {
      protection: {
        kind: o.protection === "private-url" ? "private" : "guard",
        reason: (o.reason ?? "a protection asks").replace(/\.$/, ""),
      },
    };
  }
  return {};
}

/** The facts for one call, read from the pipeline's result and the context. */
function factsOf(
  input: EvaluateInput,
  result: ToolPolicyResult,
  web: EffectiveWebLevel,
): WebCallFacts {
  const url = input.parsedArgs.url;
  const host = hostOf(url);
  const search = SEARCH_TOOL_NAMES.has(input.toolName);
  const facts: WebCallFacts = {
    level: web.level,
    levelSource: web.source,
    ...(host ? { host } : {}),
    unattended: !!input.web?.unattended,
  };
  const hard = urlHardRefusal(url);
  if (hard) facts.hardRefusal = hard;
  // The person's own `host:` allow rules
  const hostRule = host
    ? input.web?.hostAllow?.find((r) => hostRuleMatches(r, host))
    : undefined;
  if (result.source === "idgaf") {
    Object.assign(facts, idgafFacts(result));
  } else if (result.policy === "disabled") {
    if (result.source === "floor" && result.rule) facts.floorRule = result.rule;
    else facts.denied = result.reason ?? "Refused by a rule.";
  } else if (result.policy === "allowedWithPermission") {
    // A host rule answers it at every level; a grant or the URL they wrote, below Listed
    const answered =
      !!hostRule ||
      (web.level !== "listed" &&
        ((!!host && !!input.web?.grants?.isGranted(host)) ||
          urlIsFromUser(url, input.web?.userUrls)));
    const protection = protectionOf(result, answered);
    if (protection) facts.protection = protection;
    else if (
      !LEVEL_SOURCES.has(result.source) &&
      result.source !== "protected-path"
    ) {
      // An ask rule, the tainted-session rule, a guard: asks, refused at Listed
      facts.askRule = result.reason ?? "A rule asks before this runs.";
    }
  }
  if (host && input.web?.grants?.isBlocked(host)) facts.sessionBlock = true;
  if (host && input.web?.grants?.isGranted(host)) facts.sessionGrant = true;
  if (urlIsFromUser(url, input.web?.userUrls)) facts.urlInUserMessage = true;
  if (result.policy === "allowedWithoutPermission") {
    if (result.source === "allow-rule") {
      facts.hostAllowed = { reason: result.reason ?? "Allowed by your rule." };
    } else if (
      result.source === "tool-setting" ||
      result.source === undefined ||
      result.source === "default"
    ) {
      facts.toolSettingRuns = true;
    }
  }
  if (hostRule && !facts.hostAllowed) {
    facts.hostAllowed = {
      reason: `Allowed: your rule ${hostRule} covers ${host}.`,
    };
  }
  // trustedDomains stands in for `host:` allow rules until WB21 (DC-5): the
  // domain and its subdomains, read from the person's own config.yaml only
  if (!facts.hostAllowed && host && input.trustedDomains?.length) {
    if (hostTrusted(host, input.trustedDomains)) {
      facts.hostAllowed = {
        reason: `Allowed: ${host} is one of your trusted domains.`,
      };
    }
  }
  if (!facts.hostAllowed && search) {
    facts.hostAllowed = {
      reason:
        "Allowed: the search backend you configured counts as an allowed domain.",
    };
  }
  return facts;
}

/** The source a Web decision is shown with, by the step that decided. */
function sourceOf(
  decision: WebDecision,
  result: ToolPolicyResult,
): ToolPolicyResult["source"] {
  switch (decision.step) {
    case 2:
      return "tool-setting";
    case 4:
      return "safety-floor";
    case 5:
      return "floor";
    case 6:
      return "idgaf";
    case 7:
      return result.policy === "disabled" ? result.source : "deny-rule";
    case 11:
      return "allow-rule";
    default:
      return "default";
  }
}

/** The decision as the permission layer's result, keeping the pipeline's own where it agrees. */
function resultOf(
  decision: WebDecision,
  result: ToolPolicyResult,
): ToolPolicyResult {
  const policy: ToolPolicy =
    decision.outcome === "run"
      ? "allowedWithoutPermission"
      : decision.outcome === "ask" || decision.outcome === "review"
        ? "allowedWithPermission"
        : "disabled";
  if (policy === result.policy && decision.step !== 4 && decision.step !== 5) {
    return result;
  }
  const { idgafOverride: _o, protection: _p, rule: _r, ...rest } = result;
  const rule =
    decision.step === 5
      ? (result.idgafOverride?.rule ?? result.rule)
      : undefined;
  return {
    ...rest,
    policy,
    source: sourceOf(decision, result),
    reason: decision.reason,
    ...(rule ? { rule } : {}),
  };
}

/**
 * The Web area's step in the permission layer: the last one, after IDGAF has
 * run, so the hard checks, `floor:` rules and Off bind at every level. For a
 * call outside the Web area, or a tool the person switched off, the result is
 * returned as it is.
 */
export function applyWebArea(
  input: EvaluateInput,
  result: ToolPolicyResult,
): ToolPolicyResult {
  if (!isWebToolName(input.toolName) || !input.tool) return result;
  if (input.basePolicy === "disabled") return result;
  const web = effectiveWebLevel(input.approval?.levels, input.web);
  // A caller that sends no levels and no web context: only the hard checks,
  // so a caller from before the Web area sees nothing else change
  if (!input.approval && !input.web) {
    const hard = urlHardRefusal(input.parsedArgs.url);
    return hard
      ? resultOf({ outcome: "refused", step: 4, reason: hard }, result)
      : result;
  }
  const decision = decideWebCall(factsOf(input, result, web));
  return resultOf(decision, result);
}
