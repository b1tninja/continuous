import fs from "fs";
import path from "path";

import type { ChatHistoryItem, MessageContent, Session } from "core/index.js";
import { clipMasked } from "core/tools/permissions/audit/mask.js";
import {
  maskArgsForDisplay,
  maskCommandForDisplay,
} from "core/tools/permissions/displayMask.js";

/**
 * A session as a transcript a person can read and send (GAP8). Never the
 * session JSON: every text goes through the display masker (the audit
 * masker plus the environment-assignment pass), tool output is cut,
 * reasoning is left out unless asked for, attached context (file contents)
 * is left out, and the header is the title and a date only: no path, model,
 * session id or workspace.
 */
export type TranscriptFormat = "md" | "html";

export interface TranscriptOptions {
  format?: TranscriptFormat;
  /** Reasoning (thinking) text; off by default. */
  includeReasoning?: boolean;
  /** The longest tool output kept, in characters. */
  toolOutputChars?: number;
  /** The date in the header (the session's creation date when known); today by default. */
  date?: Date;
}

export const TRANSCRIPT_TOOL_OUTPUT_CHARS = 2000;
const TOOL_ARGS_CHARS = 1000;

const mask = (text: string) => maskCommandForDisplay(text);

function textOf(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : "[image omitted]"))
    .join("\n");
}

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(
    2,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
}

function dateOf(date?: Date): string {
  const d = date && !Number.isNaN(date.getTime()) ? date : new Date();
  return d.toISOString().slice(0, 10);
}

function toolCallsOf(item: ChatHistoryItem, outputChars: number): string[] {
  const parts: string[] = [];
  for (const state of item.toolCallStates ?? []) {
    const name = mask(state.toolCall?.function?.name ?? "tool");
    parts.push(`**Tool call: ${name}** (${state.status})`);
    const args = JSON.stringify(
      maskArgsForDisplay(state.parsedArgs ?? {}),
      null,
      2,
    );
    if (args && args !== "{}") {
      parts.push(fence(clipMasked(args, TOOL_ARGS_CHARS), "json"));
    }
    const output = (state.output ?? [])
      .map((o) => (typeof o.content === "string" ? o.content : ""))
      .join("\n")
      .trim();
    if (output) {
      const masked = mask(output);
      const cut = masked.length > outputChars;
      parts.push(
        fence(clipMasked(masked, outputChars)) +
          (cut
            ? `\n\n_Output cut: ${outputChars} of ${masked.length} characters shown._`
            : ""),
      );
    }
  }
  return parts;
}

/** The transcript as Markdown. */
export function renderMarkdown(
  session: Session,
  options: TranscriptOptions = {},
): string {
  const outputChars = options.toolOutputChars ?? TRANSCRIPT_TOOL_OUTPUT_CHARS;
  const title = mask(session.title?.trim() || "Untitled session").replace(
    /\s+/g,
    " ",
  );
  const out: string[] = [`# ${title}`, "", dateOf(options.date)];
  for (const item of session.history ?? []) {
    const role = item.message.role;
    if (role === "system" || role === "tool") continue;
    if (role === "thinking") {
      if (options.includeReasoning) {
        out.push("", "### Reasoning", "", mask(textOf(item.message.content)));
      }
      continue;
    }
    const raw = textOf(item.message.content);
    const text = mask(options.includeReasoning ? raw : stripThink(raw)).trim();
    out.push("", role === "user" ? "## You" : "## Assistant");
    if (options.includeReasoning && item.reasoning?.text) {
      out.push("", "### Reasoning", "", mask(item.reasoning.text));
    }
    if (text) out.push("", text);
    for (const part of toolCallsOf(item, outputChars)) out.push("", part);
  }
  return out.join("\n") + "\n";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The transcript as a self-contained HTML page: the Markdown text, escaped,
 * in a `<pre>`. No script, no markup from the session, nothing fetched.
 */
export function renderHtml(
  session: Session,
  options: TranscriptOptions = {},
): string {
  const md = renderMarkdown(session, options);
  const title = escapeHtml(md.split("\n", 1)[0].replace(/^#\s*/, ""));
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    `<title>${title}</title>`,
    "<style>body{margin:0;padding:16px;background:#fff;color:#1a1a1a;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100ch;margin:0 auto}@media (prefers-color-scheme:dark){body{background:#161616;color:#e6e6e6}}</style>",
    "</head>",
    "<body>",
    `<pre>${escapeHtml(md)}</pre>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function renderTranscript(
  session: Session,
  options: TranscriptOptions = {},
): string {
  return options.format === "html"
    ? renderHtml(session, options)
    : renderMarkdown(session, options);
}

/** The format a file name asks for: `.html` and `.htm` give HTML, anything else Markdown. */
export function formatForPath(file: string): TranscriptFormat {
  return /\.html?$/i.test(file) ? "html" : "md";
}

/** A file name for a session's transcript, in the current folder. */
export function defaultTranscriptName(
  session: Session,
  format: TranscriptFormat,
): string {
  const slug =
    (session.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session";
  return `${slug}-${dateOf()}.${format}`;
}

/**
 * Writes the transcript. Refuses to replace a file unless `force`; the file
 * is created with the exclusive flag, so a file that appears in between is
 * not replaced either.
 */
export function writeTranscript(
  file: string,
  text: string,
  force = false,
): { ok: true; path: string } | { ok: false; error: string } {
  const target = path.resolve(file);
  try {
    if (!force && fs.existsSync(target)) {
      return {
        ok: false,
        error: `${target} exists. Pass --force to replace it.`,
      };
    }
    fs.writeFileSync(target, text, {
      encoding: "utf-8",
      flag: force ? "w" : "wx",
    });
    return { ok: true, path: target };
  } catch (e) {
    return {
      ok: false,
      error: `Could not write ${target}: ${(e as Error).message}`,
    };
  }
}
