import type { Session } from "core/index.js";
import historyManager from "core/util/history.js";
import { scrubDeepCounted } from "core/util/secretScan/scrubForDisk.js";

import { getCurrentSession, loadSessionById } from "../session.js";

import {
  defaultTranscriptName,
  formatForPath,
  renderTranscriptCounted,
  writeTranscript,
  type TranscriptFormat,
} from "./transcript.js";

export interface ExportOptions {
  format?: string;
  out?: string;
  force?: boolean;
  includeReasoning?: boolean;
  /** `--raw` (V13): no masking; a warning says so. */
  raw?: boolean;
}

/** The warning `--raw` prints: nothing was masked. */
export const RAW_EXPORT_WARNING =
  "--raw: nothing was masked. The export holds the session's text as it is, keys, tokens and passwords included; read it before you share it.";

/** The line that reports the masking (V13). */
export function maskedCountLine(masked: number): string {
  return `${masked} ${masked === 1 ? "value" : "values"} masked. Masking is best effort; read it before you share it.`;
}

/** A session by id, by the start of its id, or `last` for the newest, with its creation date when listed. */
export function findSession(
  ref: string,
): { session: Session; created?: Date } | null {
  const want = ref.trim();
  if (!want) return null;
  const listed = historyManager.list({});
  const meta =
    want === "last" || want === "latest"
      ? listed[0]
      : (listed.find((s) => s.sessionId === want) ??
        listed.find((s) => s.sessionId.startsWith(want)));
  const session = loadSessionById(meta?.sessionId ?? want);
  if (!session) return null;
  const created = meta?.dateCreated ? new Date(meta.dateCreated) : undefined;
  return { session, created };
}

function formatOf(
  options: ExportOptions,
): TranscriptFormat | { error: string } {
  if (options.format === undefined) {
    return options.out ? formatForPath(options.out) : "md";
  }
  if (options.format === "md" || options.format === "html") {
    return options.format;
  }
  return { error: `--format takes md or html, got "${options.format}"` };
}

/**
 * `continuous export <session>`: the sanitised transcript to stdout, or to
 * `--out` (never over an existing file without `--force`). Returns the exit
 * code: 0, or 1 with the reason on stderr.
 */
export function exportCommand(
  ref: string,
  options: ExportOptions,
  io: {
    out: (text: string) => void;
    err: (text: string) => void;
  } = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  },
): number {
  const format = formatOf(options);
  if (typeof format !== "string") {
    io.err(`${format.error}\n`);
    return 1;
  }
  const found = findSession(ref);
  if (!found) {
    io.err(
      `No session "${ref}". List them with \`continuous ls\`, or pass "last".\n`,
    );
    return 1;
  }
  const { text, masked } = renderTranscriptCounted(found.session, {
    format,
    includeReasoning: options.includeReasoning,
    date: found.created,
    raw: options.raw,
  });
  // stdout carries only the transcript; the report goes to stderr
  const report = options.raw ? RAW_EXPORT_WARNING : maskedCountLine(masked);
  if (!options.out) {
    io.out(text);
    io.err(`${report}\n`);
    return 0;
  }
  const written = writeTranscript(options.out, text, options.force);
  if (!written.ok) {
    io.err(`${written.error}\n`);
    return 1;
  }
  io.err(`Exported to ${written.path}. ${report}\n`);
  return 0;
}

const EXPORT_FLAGS = new Set(["--force", "--reasoning", "--raw"]);

/**
 * `/export [path] [--force] [--reasoning] [--raw]` in the terminal UI: the
 * current session's sanitised transcript, Markdown unless the path ends in
 * .html. Returns the line to show, with the number of values masked, or the
 * `--raw` warning (`warning` set).
 */
export function exportCurrentSession(args: string[]): {
  ok: boolean;
  message: string;
  warning?: boolean;
} {
  const force = args.includes("--force");
  const includeReasoning = args.includes("--reasoning");
  const raw = args.includes("--raw");
  const file = args
    .filter((a) => !EXPORT_FLAGS.has(a))
    .join(" ")
    .trim();
  const session = getCurrentSession();
  if (!session.history?.some((item) => item.message.role !== "system")) {
    return { ok: false, message: "Nothing to export yet." };
  }
  const format = file ? formatForPath(file) : "md";
  const target = file || defaultTranscriptName(session, format);
  const { text, masked } = renderTranscriptCounted(session, {
    format,
    includeReasoning,
    raw,
  });
  const written = writeTranscript(target, text, force);
  if (!written.ok) return { ok: false, message: written.error };
  return raw
    ? {
        ok: true,
        warning: true,
        message: `Exported the transcript to ${written.path}. ${RAW_EXPORT_WARNING}`,
      }
    : {
        ok: true,
        message: `Exported a masked transcript to ${written.path}. ${maskedCountLine(masked)}`,
      };
}

export interface SessionExportPayload {
  version: 1;
  exportedAt: string;
  session: Session;
}

/**
 * The session JSON `/export --json` writes for `/import` (V13): every
 * string scrubbed with the at-rest secret rules (`scrubDeep`), and the
 * number of values replaced. `raw` keeps the session as it is.
 */
export function sessionExportPayload(
  session: Session,
  options: { raw?: boolean; now?: Date } = {},
): { payload: SessionExportPayload; masked: number } {
  const exportedAt = (options.now ?? new Date()).toISOString();
  if (options.raw) {
    return { payload: { version: 1, exportedAt, session }, masked: 0 };
  }
  const { value, count } = scrubDeepCounted(session);
  return {
    payload: { version: 1, exportedAt, session: value },
    masked: count,
  };
}
