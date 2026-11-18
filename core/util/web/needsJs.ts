/**
 * Whether a fetched HTML page is an application shell that needs JavaScript
 * to show its content (plans/research/web-fetch-large-pages-and-policy.md,
 * section 7.1). Pure: it reads the HTML, its `Content-Type` and the text the
 * converter extracted, and returns a verdict, a confidence and the reasons.
 *
 * A page is `needs-js` when its visible text is under 200 characters and at
 * least one of these holds: a `<noscript>` element has text; an application
 * root (`#root`, `#app`, `#__next`, ...) is empty; or there are three or more
 * `<script>` elements and the text is under 2% of the HTML's bytes. JSON and
 * plain-text responses never are.
 */

import {
  classifyContentType,
  sniffBody,
  stripHtmlComments,
} from "../fetchedText";

/** Visible text under this many characters is the first condition. */
export const NEEDS_JS_MAX_TEXT_CHARS = 200;
/** Script elements that make a page script-heavy. */
export const NEEDS_JS_MIN_SCRIPTS = 3;
/** Visible text below this share of the HTML's bytes, for a script-heavy page. */
export const NEEDS_JS_MAX_TEXT_SHARE = 0.02;
/** `<noscript>` text quoted in the result, at most. */
export const NOSCRIPT_QUOTE_CHARS = 120;
/** An application root with no more text than this (a "Loading..." line) is empty. */
const EMPTY_ROOT_MAX_TEXT_CHARS = 40;

/**
 * Element ids frameworks mount into. The note's list (`root`, `app`,
 * `__next`, `__nuxt`, `svelte`) plus `__docusaurus` and `swagger-ui`, the
 * mounts of two shells the note's fixture corpus names.
 */
export const APP_ROOT_IDS: readonly string[] = [
  "root",
  "app",
  "__next",
  "__nuxt",
  "svelte",
  "__docusaurus",
  "swagger-ui",
];
/** Attributes that mark an application root. */
export const APP_ROOT_ATTRIBUTES: readonly string[] = [
  "ng-app",
  "data-reactroot",
];
/** Custom elements that are an application root (Angular's `<app-root>`). */
export const APP_ROOT_ELEMENTS: readonly string[] = ["app-root"];

export type NeedsJsConfidence = "high" | "medium" | "low";

export interface NeedsJsVerdict {
  needsJs: boolean;
  confidence: NeedsJsConfidence;
  /** Why, in order; each a short sentence fragment. */
  reasons: string[];
  /** Characters of visible text (whitespace collapsed). */
  textChars: number;
  /** The first 120 characters of the `<noscript>` text, when there is some. */
  noscript?: string;
  /** The empty application root found, as a selector (`#root`, `[ng-app]`, `app-root`). */
  appRoot?: string;
  scripts: number;
  htmlBytes: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** Tags that separate words; inline ones (`<b>`, `<a>`) do not. */
const BLOCK_TAG =
  /<\/?(?:address|article|aside|blockquote|br|center|dd|div|dl|dt|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/gi;

/** Text of an HTML fragment: comments, scripts, styles and tags removed. */
function textOf(html: string): string {
  return collapse(
    decodeEntities(
      stripHtmlComments(html)
        .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(BLOCK_TAG, " ")
        .replace(/<[^>]*>/g, ""),
    ),
  );
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function isHtml(html: string, contentType: string | null | undefined): boolean {
  const kind = classifyContentType(contentType);
  if (kind === "unknown") return sniffBody(html) === "html";
  return kind === "html";
}

function noscriptText(html: string): string {
  const parts: string[] = [];
  const re = /<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = textOf(m[1]);
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text between an element's start tag and its matching end tag (nesting counted). */
function innerText(html: string, afterOpen: number, tag: string): string {
  const re = new RegExp(`<(/?)${escapeRegExp(tag)}(?=[\\s>/])[^>]*>`, "gi");
  re.lastIndex = afterOpen;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth--;
    else if (!m[0].endsWith("/>")) depth++;
    if (depth === 0) return textOf(html.slice(afterOpen, m.index));
  }
  return textOf(html.slice(afterOpen));
}

/** The first empty application root, as a selector. */
function emptyAppRoot(html: string): string | undefined {
  const body = stripHtmlComments(html);
  const tagRe = /<([a-zA-Z][\w-]*)(\s[^>]*)?>/g;
  for (let m = tagRe.exec(body); m; m = tagRe.exec(body)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    let selector: string | undefined;
    if (APP_ROOT_ELEMENTS.includes(tag)) {
      selector = tag;
    } else {
      const id = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const idValue = id?.[1] ?? id?.[2] ?? id?.[3];
      if (idValue !== undefined && APP_ROOT_IDS.includes(idValue)) {
        selector = `#${idValue}`;
      } else {
        const attr = APP_ROOT_ATTRIBUTES.find((a) =>
          new RegExp(`(?:^|\\s)${escapeRegExp(a)}(?:\\s*=|\\s|$)`, "i").test(
            attrs,
          ),
        );
        if (attr) selector = `[${attr}]`;
      }
    }
    if (!selector) continue;
    if (/\/\s*$/.test(attrs)) return selector;
    if (
      charLength(innerText(body, tagRe.lastIndex, tag)) <=
      EMPTY_ROOT_MAX_TEXT_CHARS
    ) {
      return selector;
    }
  }
  return undefined;
}

function countScripts(html: string): number {
  return (stripHtmlComments(html).match(/<script\b/gi) ?? []).length;
}

function percent(share: number): string {
  return `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
}

/**
 * The verdict for one response. `extractedText` is what the converter made of
 * the page (Markdown or the visible-text fallback); its length, whitespace
 * collapsed, is the page's visible text.
 */
export function needsJavaScript(
  html: string,
  contentType: string | null | undefined,
  extractedText: string,
): NeedsJsVerdict {
  const textChars = charLength(collapse(extractedText ?? ""));
  const base = { textChars, scripts: 0, htmlBytes: utf8Bytes(html ?? "") };
  if (!html || !isHtml(html, contentType)) {
    return {
      ...base,
      needsJs: false,
      confidence: "high",
      reasons: ["not an HTML response"],
    };
  }
  const scripts = countScripts(html);
  const facts = { ...base, scripts };
  if (textChars >= NEEDS_JS_MAX_TEXT_CHARS) {
    return {
      ...facts,
      needsJs: false,
      confidence: "high",
      reasons: [`${textChars} characters of visible text`],
    };
  }

  const reasons: string[] = [`only ${textChars} characters of visible text`];
  let signals = 0;
  const noscript = noscriptText(html);
  const quoted = noscript
    ? Array.from(noscript).slice(0, NOSCRIPT_QUOTE_CHARS).join("")
    : "";
  if (quoted) {
    signals++;
    reasons.push(`<noscript>: ${JSON.stringify(quoted)}`);
  }
  const appRoot = emptyAppRoot(html);
  if (appRoot) {
    signals++;
    reasons.push(`empty application root ${appRoot}`);
  }
  const share = facts.htmlBytes ? textChars / facts.htmlBytes : 0;
  if (scripts >= NEEDS_JS_MIN_SCRIPTS && share < NEEDS_JS_MAX_TEXT_SHARE) {
    signals++;
    reasons.push(
      `${scripts} <script> elements, text ${percent(share)} of the HTML`,
    );
  }

  const detail = {
    ...facts,
    ...(quoted && { noscript: quoted }),
    ...(appRoot && { appRoot }),
  };
  if (!signals) {
    reasons.push(
      "no noscript text, empty application root or script-heavy shell",
    );
    return {
      ...detail,
      needsJs: false,
      // A short page with no sign of an application is most likely just short
      confidence: scripts >= NEEDS_JS_MIN_SCRIPTS ? "low" : "medium",
      reasons,
    };
  }
  const confidence: NeedsJsConfidence =
    signals >= 2 || (appRoot && textChars < 50)
      ? "high"
      : textChars < 50
        ? "medium"
        : "low";
  return { ...detail, needsJs: true, confidence, reasons };
}
