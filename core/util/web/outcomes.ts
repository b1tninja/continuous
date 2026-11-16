/**
 * Typed outcomes of a web fetch and their exact texts (plans/research/
 * web-fetch-large-pages-and-policy.md, sections 6.1 and 6.2, row WB41).
 * Every web path (`fetch_url_content`, the CLI `Fetch`, `@url`) reports one
 * of these codes instead of a bare thrown message, and every text says
 * whether repeating the call can help.
 *
 * Pure: no Node imports and no network. The mapping from guard errors and
 * responses to these codes is in `fetchOutcome.ts`.
 *
 * Rules (section 6.1):
 * - First sentence: what happened, naming the host and the status. Second:
 *   whether repeating the call can help. Third: what to do instead.
 * - No response body is ever quoted. The only server text that may appear is
 *   a `<noscript>` line or a `WWW-Authenticate` scheme and realm, each
 *   cleaned and cut to 120 characters (`quoteServerText`).
 */

/** The 26 outcome codes of section 6.2, in the note's order. */
export const WEB_OUTCOME_CODES = [
  "ok",
  "partial",
  "from-session",
  "robots",
  "blocked",
  "declined",
  "refused-unattended",
  "not-text",
  "needs-js",
  "needs-cookies",
  "auth-required",
  "forbidden",
  "rate-limited",
  "host-limit",
  "timeout",
  "dns",
  "dns-temporary",
  "tls",
  "connection",
  "not-found",
  "gone",
  "server-error",
  "client-error",
  "repeat",
  "expired",
  "not-found-id",
] as const;

/**
 * An outcome code. `refused` is the code the existing hard refusals carry
 * (scheme, userinfo, a credential in the URL, a redirect to a non-public
 * address); their wording is kept and gains "Do not retry it unchanged."
 */
export type WebOutcomeCode = (typeof WEB_OUTCOME_CODES)[number] | "refused";

/**
 * The note's "Retry can help?" column:
 * - `n/a`: not an error;
 * - `no`: repeating the same call returns the same answer;
 * - `after-delay`: yes, once the stated time has passed;
 * - `once`: one retry may help, not a second;
 * - `once-later`: one retry after other work, not again;
 * - `fetch-again`: fetching the URL again is the fix (an evicted id).
 */
export type RetryAdvice =
  "n/a" | "no" | "after-delay" | "once" | "once-later" | "fetch-again";

export const RETRY_ADVICE: Readonly<Record<WebOutcomeCode, RetryAdvice>> = {
  ok: "n/a",
  partial: "n/a",
  "from-session": "n/a",
  robots: "no",
  blocked: "no",
  declined: "no",
  "refused-unattended": "no",
  "not-text": "no",
  "needs-js": "no",
  "needs-cookies": "no",
  "auth-required": "no",
  forbidden: "no",
  "rate-limited": "after-delay",
  "host-limit": "after-delay",
  timeout: "once",
  dns: "no",
  "dns-temporary": "once",
  tls: "no",
  connection: "once",
  "not-found": "no",
  gone: "no",
  "server-error": "once-later",
  "client-error": "no",
  repeat: "no",
  expired: "fetch-again",
  "not-found-id": "no",
  refused: "no",
};

export interface WebOutcome {
  code: WebOutcomeCode;
  retry: RetryAdvice;
  /** The exact text for the model, after the provenance line. */
  text: string;
  /**
   * The first sentence: what happened. What a person sees for `@url`, where
   * advice addressed to the model would read oddly.
   */
  summary: string;
  /** The host the outcome names, when there is one. */
  host?: string;
  /** The HTTP status, when a response came back. */
  httpStatus?: number;
  /** For `after-delay` outcomes: when a new request may be made (ISO 8601, UTC). */
  retryAt?: string;
}

/** The sentence the hard refusals gain. */
export const DO_NOT_RETRY = "Do not retry it unchanged.";

/** The second half of the permission refusals (`toolListHold.ts`). */
export const CARRY_ON =
  "Do not retry this call or reach the same result another way. Do what else the request needs, then say what you could not do and why.";

/** Server text quoted in a result is cut to this many characters. */
export const MAX_QUOTE_CHARS = 120;

/** Characters that never reach a quoted fragment. */
// eslint-disable-next-line no-control-regex
const UNSAFE_QUOTE_CHARS =
  /[\u0000-\u001f\u007f-\u009f"\\<>`\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/**
 * Server text (a realm, a `<noscript>` line) made safe to quote: control,
 * invisible and quoting characters removed, whitespace collapsed, cut to 120
 * characters.
 */
export function quoteServerText(text: string | undefined | null): string {
  if (!text) return "";
  const clean = text
    .replace(UNSAFE_QUOTE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, MAX_QUOTE_CHARS).join("");
}

function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
}

function outcome(
  code: WebOutcomeCode,
  text: string,
  extra: Partial<Omit<WebOutcome, "code" | "retry" | "text">> = {},
): WebOutcome {
  return {
    code,
    retry: RETRY_ADVICE[code],
    text,
    summary: extra.summary ?? firstSentence(text),
    ...(extra.host !== undefined && { host: extra.host }),
    ...(extra.httpStatus !== undefined && { httpStatus: extra.httpStatus }),
    ...(extra.retryAt !== undefined && { retryAt: extra.retryAt }),
  };
}

const num = (n: number) => Math.round(n).toLocaleString("en-US");

/** `1 second`, `20 seconds`. */
const secondsText = (n: number) =>
  `${num(n)} second${Math.round(n) === 1 ? "" : "s"}`;

/** `hh:mm` in UTC. */
function hhmm(at: Date): string {
  return at.toISOString().slice(11, 16);
}

/** `hh:mm:ss` in UTC. */
function hhmmss(at: Date): string {
  return at.toISOString().slice(11, 19);
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ??
        "th");
  return `${n}${suffix}`;
}

// ---------------------------------------------------------------------------
// Status reason phrases (RFC 9110 section 15). The server's own reason phrase
// is not used: HTTP/2 has none, and it is text the server chose.

const REASON_PHRASES: Readonly<Record<number, string>> = {
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
};

/** The standard reason phrase, or a cleaned, short copy of the server's for a status not listed. */
export function reasonPhrase(status: number, statusText?: string): string {
  const known = REASON_PHRASES[status];
  if (known) return known;
  return (statusText ?? "")
    .replace(/[^A-Za-z0-9 '-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

const statusWithReason = (status: number, statusText?: string) =>
  [String(status), reasonPhrase(status, statusText)].filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Retry-After (RFC 9110 section 10.2.3): an HTTP-date or delay-seconds.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH = MONTHS.join("|");
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";

const IMF_FIXDATE = new RegExp(
  `^(?:${DAY_NAMES.join("|")}), (\\d{2}) (${MONTH}) (\\d{4}) ${TIME} GMT$`,
);
const RFC850_DATE = new RegExp(
  `^(?:${LONG_DAY_NAMES.join("|")}), (\\d{2})-(${MONTH})-(\\d{2}) ${TIME} GMT$`,
);
const ASCTIME_DATE = new RegExp(
  `^(?:${DAY_NAMES.join("|")}) (${MONTH}) ( \\d|\\d{2}) ${TIME} (\\d{4})$`,
);

function utc(
  year: number,
  month: string,
  day: number,
  h: string,
  m: string,
  s: string,
): number | undefined {
  const mon = MONTHS.indexOf(month);
  const hour = Number(h);
  const minute = Number(m);
  // 60 is a leap second (RFC 9110 section 5.6.7)
  const second = Math.min(Number(s), 59);
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const ms = Date.UTC(year, mon, day, hour, minute, second);
  // Reject a day past the month's end (31 Feb) rather than rolling over
  if (new Date(ms).getUTCDate() !== day) return undefined;
  return ms;
}

/**
 * An HTTP-date in any of its three formats, which a recipient MUST accept
 * (RFC 9110 section 5.6.7): IMF-fixdate, the obsolete RFC 850 form and
 * asctime. Case-sensitive, as the grammar is. A two-digit RFC 850 year more
 * than 50 years in the future is the most recent past year with those
 * digits. Milliseconds since the epoch, or undefined.
 */
export function parseHttpDate(
  value: string,
  now: Date = new Date(),
): number | undefined {
  const v = value.trim();
  let m = IMF_FIXDATE.exec(v);
  if (m) return utc(Number(m[3]), m[2], Number(m[1]), m[4], m[5], m[6]);
  m = RFC850_DATE.exec(v);
  if (m) {
    const thisYear = now.getUTCFullYear();
    let year = Math.floor(thisYear / 100) * 100 + Number(m[3]);
    if (year > thisYear + 50) year -= 100;
    return utc(year, m[2], Number(m[1]), m[4], m[5], m[6]);
  }
  m = ASCTIME_DATE.exec(v);
  if (m) return utc(Number(m[6]), m[1], Number(m[2].trim()), m[3], m[4], m[5]);
  return undefined;
}

export interface RetryAfter {
  /** Whole seconds to wait from when the response was received. */
  seconds: number;
  /** When a new request may be made. */
  at: Date;
  form: "delay-seconds" | "http-date";
}

/**
 * `Retry-After` (RFC 9110 section 10.2.3): "how long the user agent ought to
 * wait before making a follow-up request", as delay-seconds (`1*DIGIT`, a
 * non-negative decimal integer) or an HTTP-date. An HTTP-date is measured
 * against the response's own `Date` when it has one, so a skewed local
 * clock does not stretch or shrink the wait; a date in the past is a wait of
 * 0. Anything else is undefined, as if the field were absent.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  options: { now?: Date; date?: string | null } = {},
): RetryAfter | undefined {
  if (value === null || value === undefined) return undefined;
  const now = options.now ?? new Date();
  // A recipient may see a list when the field was repeated; the first counts
  const v = value.split(",")[0].trim();
  if (/^\d+$/.test(v)) {
    const seconds = Number(v);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return {
      seconds,
      at: new Date(now.getTime() + seconds * 1000),
      form: "delay-seconds",
    };
  }
  // The comma in an IMF-fixdate is part of the date
  const at = parseHttpDate(value.trim(), now);
  if (at === undefined) return undefined;
  const base =
    (options.date ? parseHttpDate(options.date, now) : undefined) ??
    now.getTime();
  const seconds = Math.max(0, Math.ceil((at - base) / 1000));
  return {
    seconds,
    at: new Date(now.getTime() + seconds * 1000),
    form: "http-date",
  };
}

// ---------------------------------------------------------------------------
// WWW-Authenticate (RFC 9110 section 11.6.1): the first challenge's scheme and
// realm, for the `auth-required` text.

export interface AuthChallenge {
  scheme: string;
  realm?: string;
}

/** The first challenge of a `WWW-Authenticate` value, cleaned for quoting. */
export function parseWwwAuthenticate(
  value: string | null | undefined,
): AuthChallenge | undefined {
  if (!value) return undefined;
  const first = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)/.exec(value);
  if (!first) return undefined;
  const scheme = first[1];
  // This challenge's parameters, one `name=value` at a time: a token not
  // followed by `=` starts the next challenge, so its realm is not taken
  let rest = value.slice(first[0].length);
  let raw: string | undefined;
  for (let i = 0; i < 32; i++) {
    const param =
      /^[\s,]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/.exec(
        rest,
      );
    if (!param) break;
    if (param[1].toLowerCase() === "realm") {
      raw =
        param[2] === undefined ? param[3] : param[2].replace(/\\(.)/g, "$1");
      break;
    }
    rest = rest.slice(param[0].length);
  }
  const realm = quoteServerText(raw);
  return {
    scheme: quoteServerText(scheme),
    ...(realm && { realm }),
  };
}

// ---------------------------------------------------------------------------
// The texts, one builder per code (section 6.2). `<host>`, `<url>`, `<n>` and
// the like are the parameters.

/** `partial`: the page is larger than the window. */
// TODO(WB39): produced by the large-page result once the content store (WB37)
// and the window (WB38) are wired into fetch_url_content.
export function partialOutcome(p: {
  totalTokens: number;
  shownTokens: number;
  lastLine: number;
  totalLines: number;
  pages: number;
  id: string;
  outline: readonly string[];
}): WebOutcome {
  const text = [
    `This page is ~${num(p.totalTokens)} tokens; this shows the first ~${num(p.shownTokens)} (lines 1-${num(p.lastLine)} of ${num(p.totalLines)}, page 1 of ${p.pages}). It is saved for this session as ${p.id}, so reading more does not fetch it again.`,
    "Outline (line, ~tokens):",
    ...p.outline,
    `To read more, call read_web_content with id "${p.id}" and one of: section (a number or heading from the outline), page (2 to ${p.pages}), offset (a line number), or grep (a pattern; returns matching lines with their numbers). This is not an error: do not fetch this URL again.`,
  ].join("\n");
  return outcome("partial", text);
}

/** `from-session`: a fresh stored copy answered the fetch. */
// TODO(WB39): produced when the content store answers a repeated fetch.
export function fromSessionOutcome(p: {
  fetchedAt: Date;
  now?: Date;
}): WebOutcome {
  const now = p.now ?? new Date();
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - p.fetchedAt.getTime()) / 60_000),
  );
  return outcome(
    "from-session",
    `This is this session's copy from ${hhmm(p.fetchedAt)} UTC (${minutes} minutes old); it was not fetched again. Pass refresh: true if the page has changed since.`,
  );
}

/** `robots`: robots.txt disallows the path for automated agents. */
// TODO(WB20): produced by the tool's robots check, which reads the WB18 parser.
export function robotsOutcome(p: { host: string; path: string }): WebOutcome {
  return outcome(
    "robots",
    `Not fetched: robots.txt on ${p.host} asks automated agents not to read ${p.path}. Retrying will not change this. If the page is needed, ask the person; a URL they write in a message is fetched without this check.`,
    { host: p.host },
  );
}

/**
 * `blocked`: a deny rule, the Web level, a ceiling or a session block.
 * `reason` is the clause after "Refused: ", e.g. `a rule blocks docs.example
 * (deny host:*.example, your permissions.yaml)`.
 */
// TODO(WB45): produced by the Web policy area's decision.
export function blockedOutcome(p: {
  reason: string;
  host?: string;
}): WebOutcome {
  return outcome(
    "blocked",
    `Refused: ${p.reason}. It was not fetched. ${CARRY_ON}`,
    { host: p.host },
  );
}

/** `declined`: the person answered No. */
// TODO(WB45/WB46): produced by the Web ask.
export function declinedOutcome(p: { host: string }): WebOutcome {
  return outcome(
    "declined",
    `Not fetched: the person declined reading ${p.host}. Do not retry it; carry on without it, or ask them why if you need it.`,
    { host: p.host },
  );
}

/**
 * `refused-unattended`: an ask in a headless run. The CO2 text, unchanged,
 * as the CLI builds it (`headlessAskRefusal`, naming `--policy web=<level>`).
 */
// TODO(WB48): produced by the CLI's headless policy for the Web area.
export function refusedUnattendedOutcome(p: {
  refusal: string;
  host?: string;
}): WebOutcome {
  return outcome("refused-unattended", p.refusal, { host: p.host });
}

/** `not-text`: a binary content type, or a body sniffed as binary. */
export function notTextOutcome(p: {
  host: string;
  mediaType: string;
  httpStatus?: number;
}): WebOutcome {
  const type = p.mediaType || "binary data";
  const pdf = /^application\/(x-)?pdf$/i.test(type)
    ? " PDF text extraction is not available in this version."
    : "";
  return outcome(
    "not-text",
    `Not read: ${p.host} returned ${type}, not text. Only HTML, plain text, Markdown, JSON and XML are read, and fetching it again returns the same file.${pdf} If the person needs it, ask them to open or download it.`,
    { host: p.host, httpStatus: p.httpStatus },
  );
}

/** Which browser tail the `needs-js` text ends with (section 7.2). */
export type BrowserTail =
  | { kind: "offered"; navigate: string; snapshot?: string }
  | { kind: "configured"; server: string }
  | { kind: "none" };

/** `needs-js`: the HTML is an application shell (section 7.1). */
export function needsJsOutcome(p: {
  host: string;
  textChars: number;
  noscript?: string;
  browser?: BrowserTail;
  httpStatus?: number;
}): WebOutcome {
  const quoted = quoteServerText(p.noscript);
  const head = `Fetched, but ${p.host} serves a page that needs JavaScript: the HTML is an application shell with ${num(p.textChars)} characters of text${quoted ? `; <noscript>: "${quoted}"` : ""}. This tool does not run JavaScript, so fetching it again returns the same shell.`;
  const browser = p.browser ?? { kind: "none" };
  let tail: string;
  if (browser.kind === "offered") {
    tail = browser.snapshot
      ? `A browser tool is available: call ${browser.navigate} with this URL, then ${browser.snapshot} to read the page. It runs outside this fetch's rules and records, and each call asks as your Web level says.`
      : `A browser tool is available: call ${browser.navigate} with this URL to read the page. It runs outside this fetch's rules and records, and each call asks as your Web level says.`;
  } else if (browser.kind === "configured") {
    tail = `A browser server (${browser.server}) is configured but its tools are not available in this session. Ask the person to turn them on if this page is needed.`;
  } else {
    // TODO(WB44): restore the note's ending, "Or tell the person this page
    // needs a browser; they have been offered one.", once the IDE card that
    // offers it exists. Until then the text says only what is true.
    tail =
      "No browser tool is configured; the person can add one (Playwright MCP) in Settings. Look for another source: the project's docs repository, an API, an llms.txt or a .md version of the page, or tell the person this page needs a browser.";
  }
  return outcome("needs-js", `${head}\n${tail}`, {
    host: p.host,
    httpStatus: p.httpStatus,
  });
}

/** `needs-cookies`: the redirects looped while setting cookies (a sign-in or consent wall). */
export function needsCookiesOutcome(p: {
  host: string;
  hops: number;
}): WebOutcome {
  return outcome(
    "needs-cookies",
    `Not read: ${p.host} keeps redirecting (${p.hops} hops) while setting cookies, which is a sign-in or consent wall. This fetch keeps no cookies between sites, so retrying loops the same way. Ask the person for the content, or use a browser tool if one is configured.`,
    { host: p.host },
  );
}

/** `auth-required`: 401. */
export function authRequiredOutcome(p: {
  host: string;
  challenge?: AuthChallenge;
}): WebOutcome {
  const c = p.challenge;
  const challenge = c
    ? ` (${c.scheme}${c.realm ? ` realm="${c.realm}"` : ""})`
    : "";
  return outcome(
    "auth-required",
    `Not read: ${p.host} answered 401 Unauthorized; it wants a sign-in${challenge}. This fetch never sends cookies or credentials, so retrying gets the same answer. Ask the person for the content, or whether a per-host header in their own config should cover this site.`,
    { host: p.host, httpStatus: 401 },
  );
}

/** `forbidden`: 403. */
export function forbiddenOutcome(p: { host: string }): WebOutcome {
  return outcome(
    "forbidden",
    `Not read: ${p.host} answered 403 Forbidden. The site refuses this request: a sign-in wall or a block on automated agents. ${DO_NOT_RETRY} Look for the same content elsewhere (an official docs repository, an API, an llms.txt or .md version), or ask the person.`,
    { host: p.host, httpStatus: 403 },
  );
}

/** Wait used when a 429 carries no `Retry-After`. */
export const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

/**
 * `rate-limited`: 429, or 503 with `Retry-After`. Without a `Retry-After`
 * the text says so and asks for `DEFAULT_RATE_LIMIT_WAIT_SECONDS`.
 */
export function rateLimitedOutcome(p: {
  host: string;
  status: 429 | 503;
  retryAfter?: RetryAfter;
  now?: Date;
}): WebOutcome {
  const now = p.now ?? new Date();
  const wait = p.retryAfter
    ? `asks to wait ${secondsText(p.retryAfter.seconds)} (Retry-After)`
    : `gives no Retry-After, so wait at least ${DEFAULT_RATE_LIMIT_WAIT_SECONDS} seconds`;
  const at =
    p.retryAfter?.at ??
    new Date(now.getTime() + DEFAULT_RATE_LIMIT_WAIT_SECONDS * 1000);
  // TODO(WB42): restore the note's second sentence, "It can be fetched again
  // after <time> UTC; a call before then is answered from this result without
  // contacting the site.", once the repeat guard answers such a call. Until
  // then an earlier call does reach the site, so the text says only that.
  return outcome(
    "rate-limited",
    `Not fetched yet: ${p.host} answered ${statusWithReason(p.status)} and ${wait}. Wait until ${hhmmss(at)} UTC before fetching it again; an earlier call gets the same answer from the site. Do other work meanwhile.`,
    { host: p.host, httpStatus: p.status, retryAt: at.toISOString() },
  );
}

/** `host-limit`: this session's own per-host limit. */
// TODO(WB25): produced by the per-host rate limit (#898 section 7.4).
export function hostLimitOutcome(p: {
  host: string;
  requests: number;
  waitSeconds: number;
  ids?: readonly string[];
  now?: Date;
}): WebOutcome {
  const now = p.now ?? new Date();
  const ids = p.ids?.length ? p.ids.join(", ") : "none";
  return outcome(
    "host-limit",
    `Not fetched: this session has made ${p.requests} requests to ${p.host} in the last minute, the limit. Try again in ${secondsText(p.waitSeconds)}, or use what you already have (${ids}).`,
    {
      host: p.host,
      retryAt: new Date(now.getTime() + p.waitSeconds * 1000).toISOString(),
    },
  );
}

/** `timeout`: the deadline passed. */
export function timeoutOutcome(p: {
  host: string;
  seconds: number;
}): WebOutcome {
  return outcome(
    "timeout",
    `Not fetched: ${p.host} did not finish answering within ${secondsText(Math.max(1, p.seconds))}. One retry may help if the site was slow; if it times out again, the page is too slow for this tool, so do not retry a third time.`,
    { host: p.host },
  );
}

/** `dns`: no such domain, or no address. */
export function dnsOutcome(p: { host: string }): WebOutcome {
  return outcome(
    "dns",
    `Not fetched: the name ${p.host} does not resolve (no such domain). Retrying will not help. Check the spelling; the URL may be wrong or invented.`,
    { host: p.host },
  );
}

/** `dns-temporary`: `EAI_AGAIN`, SERVFAIL, a resolver timeout. */
export function dnsTemporaryOutcome(p: { host: string }): WebOutcome {
  return outcome(
    "dns-temporary",
    `Not fetched: the DNS lookup for ${p.host} failed temporarily. One retry may help; if it fails again, tell the person their network or resolver may be down.`,
    { host: p.host },
  );
}

/** `tls`: certificate or handshake failure. `reason` is ours, never the server's. */
export function tlsOutcome(p: { host: string; reason: string }): WebOutcome {
  return outcome(
    "tls",
    `Not fetched: the TLS certificate of ${p.host} could not be verified (${p.reason}). No connection was made, and retrying will not change this. Do not suggest turning verification off. Tell the person; for an internal site with its own CA, they can add the CA in their own config (requestOptions.caBundlePath).`,
    { host: p.host },
  );
}

export type ConnectionFailure = "refused" | "reset" | "unreachable";

/** `connection`: refused, reset, unreachable. */
export function connectionOutcome(p: {
  host: string;
  failure: ConnectionFailure;
}): WebOutcome {
  return outcome(
    "connection",
    `Not fetched: the connection to ${p.host} was ${p.failure}. One retry may help if the site was restarting; if it fails again, do not retry, and tell the person.`,
    { host: p.host },
  );
}

/** `not-found`: 404. */
export function notFoundOutcome(p: { host: string; path: string }): WebOutcome {
  return outcome(
    "not-found",
    `Not found: ${p.host} answered 404 for ${p.path}. The page is not at this address (or the site hides it). Retrying will not help. Check the URL; for documentation, start from the site's index or search it.`,
    { host: p.host, httpStatus: 404 },
  );
}

/** `gone`: 410. */
export function goneOutcome(p: { host: string; path: string }): WebOutcome {
  return outcome(
    "gone",
    `Gone: ${p.host} answered 410 for ${p.path}: it was removed on purpose. Do not retry it; look for its replacement.`,
    { host: p.host, httpStatus: 410 },
  );
}

/** `server-error`: 5xx without `Retry-After`. */
export function serverErrorOutcome(p: {
  host: string;
  status: number;
  statusText?: string;
}): WebOutcome {
  return outcome(
    "server-error",
    `Not read: ${p.host} answered ${statusWithReason(p.status, p.statusText)}. The site failed; an immediate retry rarely helps. Try once more after other work, and not again after that.`,
    { host: p.host, httpStatus: p.status },
  );
}

/** `client-error`: any other 4xx (and a final 3xx with nowhere to go). */
export function clientErrorOutcome(p: {
  host: string;
  status: number;
  statusText?: string;
}): WebOutcome {
  return outcome(
    "client-error",
    `Not read: ${p.host} answered ${statusWithReason(p.status, p.statusText)}. Retrying the same request will not change this.`,
    { host: p.host, httpStatus: p.status },
  );
}

/** `repeat`: the repeat guard's third identical call. */
// TODO(WB42): produced by the repeat guard (section 6.4).
export function repeatOutcome(p: {
  count: number;
  url: string;
  earlier: WebOutcomeCode;
  id?: string;
}): WebOutcome {
  const read = p.id ? ` Read it with read_web_content (id "${p.id}").` : "";
  return outcome(
    "repeat",
    `Not fetched again: this is the ${ordinal(p.count)} identical fetch of ${p.url} in this session, and the earlier ones returned ${p.earlier}. Repeating it will not change the result.${read} Otherwise fetch a different URL, or tell the person what you could not read.`,
  );
}

/** `expired`: a read names an evicted id. */
// TODO(WB39/WB40): produced when read_web_content names an id the store evicted.
export function expiredOutcome(p: { id: string }): WebOutcome {
  return outcome(
    "expired",
    `${p.id} is no longer in this session's store (it was removed to save memory). Fetch the URL again; that does not count as a repeat.`,
  );
}

/** `not-found-id`: a read names an unknown id. */
// TODO(WB40): produced by read_web_content.
export function notFoundIdOutcome(p: {
  id: string;
  known: readonly string[];
}): WebOutcome {
  return outcome(
    "not-found-id",
    `No page with id ${p.id} in this session. Known: ${p.known.length ? p.known.join(", ") : "none"}.`,
  );
}

/**
 * `refused`: an existing hard refusal (scheme, userinfo, credential in the
 * URL, a redirect the guard refuses), its wording kept, with "Do not retry
 * it unchanged." added. The person sees the refusal as it was.
 */
export function refusedOutcome(p: {
  message: string;
  host?: string;
}): WebOutcome {
  const message = p.message.trim();
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return outcome("refused", `${sentence} ${DO_NOT_RETRY}`, {
    host: p.host,
    summary: message,
  });
}

// ---------------------------------------------------------------------------
// HTTP status classes

export interface StatusInput {
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  url: URL;
  now?: Date;
}

/** The path a status text names: path and query, as the server received them. */
export function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * The outcome for a response that is not 2xx. `Retry-After` turns a 503
 * into `rate-limited`. No body is read or quoted: the guard does not read
 * the body of a status of 400 or more.
 */
// TODO(WB25): a 503 with a `Retry-After` of 10 s or less is waited for once
// inside the tool (#898 section 7.4); until then every `Retry-After` is
// returned as `rate-limited`.
export function outcomeForStatus(input: StatusInput): WebOutcome {
  const { status, url } = input;
  const host = url.host;
  const path = pathOf(url);
  if (status === 401) {
    return authRequiredOutcome({
      host,
      challenge: parseWwwAuthenticate(input.headers.get("www-authenticate")),
    });
  }
  if (status === 403) return forbiddenOutcome({ host });
  if (status === 404) return notFoundOutcome({ host, path });
  if (status === 410) return goneOutcome({ host, path });
  if (status === 429 || status === 503) {
    const retryAfter = parseRetryAfter(input.headers.get("retry-after"), {
      now: input.now,
      date: input.headers.get("date"),
    });
    if (status === 429 || retryAfter) {
      return rateLimitedOutcome({
        host,
        status,
        retryAfter,
        now: input.now,
      });
    }
  }
  if (status >= 500) {
    return serverErrorOutcome({
      host,
      status,
      statusText: input.statusText,
    });
  }
  return clientErrorOutcome({ host, status, statusText: input.statusText });
}

// ---------------------------------------------------------------------------
// Network errors, by the `code` Node and its HTTP clients set (node-fetch's
// FetchError, undici's `cause`).

export type NetworkFailure =
  | { kind: "dns" }
  | { kind: "dns-temporary" }
  | { kind: "tls"; reason: string }
  | { kind: "connection"; failure: ConnectionFailure }
  | { kind: "timeout" };

const DNS_PERMANENT = new Set([
  "ENOTFOUND",
  "ENODATA",
  "ENONAME",
  "EAI_NONAME",
]);
const DNS_TEMPORARY = new Set(["EAI_AGAIN", "ESERVFAIL", "ETIMEOUT"]);
/**
 * The resolver's codes for a lookup that may succeed later: the above, and
 * a DNS server that refused or a lookup that was cancelled. Only read from
 * the resolver (`dnsCode`), where `ECONNREFUSED` is the DNS server's.
 */
const RESOLVER_TEMPORARY = new Set([
  ...DNS_TEMPORARY,
  "ECONNREFUSED",
  "ECANCELLED",
]);
const CONNECT_REFUSED = new Set(["ECONNREFUSED"]);
const CONNECT_RESET = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);
const CONNECT_UNREACHABLE = new Set([
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
]);
const TIMEOUT = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Our own words for TLS failures; the server's are never quoted. */
const TLS_REASONS: Readonly<Record<string, string>> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "self-signed certificate in the chain",
  CERT_HAS_EXPIRED: "the certificate has expired",
  CERT_NOT_YET_VALID: "the certificate is not yet valid",
  ERR_TLS_CERT_ALTNAME_INVALID: "the certificate does not name this host",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the issuer is not trusted here",
  UNABLE_TO_GET_ISSUER_CERT: "the issuer is not trusted here",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the issuer is not trusted here",
  CERT_UNTRUSTED: "the issuer is not trusted here",
  CERT_REVOKED: "the certificate was revoked",
  CERT_SIGNATURE_FAILURE: "the certificate signature is invalid",
  ERR_SSL_WRONG_VERSION_NUMBER: "the TLS handshake failed",
  EPROTO: "the TLS handshake failed",
};

/** Every `code` on an error and its `cause` chain, outermost first. */
export function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let e: unknown = error;
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code) codes.push(code);
    e = (e as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * The kind of network failure an error is, from its codes, or undefined
 * when it is none of these. `dnsCode` is the resolver's own code for the
 * host when the lookup failed before the connection (`ENOTFOUND` from the
 * pinned lookup then means "no address", and the resolver says why).
 */
export function classifyNetworkError(
  error: unknown,
  dnsCode?: string,
): NetworkFailure | undefined {
  for (const code of errorCodes(error)) {
    if (DNS_PERMANENT.has(code)) {
      return dnsCode && RESOLVER_TEMPORARY.has(dnsCode)
        ? { kind: "dns-temporary" }
        : { kind: "dns" };
    }
    if (DNS_TEMPORARY.has(code)) return { kind: "dns-temporary" };
    if (CONNECT_REFUSED.has(code)) {
      return { kind: "connection", failure: "refused" };
    }
    if (CONNECT_RESET.has(code)) {
      return { kind: "connection", failure: "reset" };
    }
    if (CONNECT_UNREACHABLE.has(code)) {
      return { kind: "connection", failure: "unreachable" };
    }
    if (TIMEOUT.has(code)) return { kind: "timeout" };
    if (TLS_REASONS[code]) return { kind: "tls", reason: TLS_REASONS[code] };
    if (/^ERR_SSL_|^ERR_TLS_|CERT/.test(code)) {
      return { kind: "tls", reason: "the TLS handshake failed" };
    }
  }
  return undefined;
}

/** The outcome for a network failure. */
export function outcomeForNetworkFailure(
  failure: NetworkFailure,
  p: { host: string; deadlineSeconds: number },
): WebOutcome {
  switch (failure.kind) {
    case "dns":
      return dnsOutcome({ host: p.host });
    case "dns-temporary":
      return dnsTemporaryOutcome({ host: p.host });
    case "tls":
      return tlsOutcome({ host: p.host, reason: failure.reason });
    case "connection":
      return connectionOutcome({ host: p.host, failure: failure.failure });
    case "timeout":
      return timeoutOutcome({ host: p.host, seconds: p.deadlineSeconds });
  }
}
