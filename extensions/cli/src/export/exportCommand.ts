import type { Session } from "core/index.js";
import historyManager from "core/util/history.js";

import { getCurrentSession, loadSessionById } from "../session.js";

import {
  defaultTranscriptName,
  formatForPath,
  renderTranscript,
  writeTranscript,
  type TranscriptFormat,
} from "./transcript.js";

export interface ExportOptions {
  format?: string;
  out?: string;
  force?: boolean;
  includeReasoning?: boolean;
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
  const text = renderTranscript(found.session, {
    format,
    includeReasoning: options.includeReasoning,
    date: found.created,
  });
  if (!options.out) {
    io.out(text);
    return 0;
  }
  const written = writeTranscript(options.out, text, options.force);
  if (!written.ok) {
    io.err(`${written.error}\n`);
    return 1;
  }
  io.err(`Exported to ${written.path}\n`);
  return 0;
}

/**
 * `/export [path] [--force] [--reasoning]` in the terminal UI: the current
 * session's sanitised transcript, Markdown unless the path ends in .html.
 * Returns the line to show.
 */
export function exportCurrentSession(args: string[]): {
  ok: boolean;
  message: string;
} {
  const force = args.includes("--force");
  const includeReasoning = args.includes("--reasoning");
  const file = args
    .filter((a) => a !== "--force" && a !== "--reasoning")
    .join(" ")
    .trim();
  const session = getCurrentSession();
  if (!session.history?.some((item) => item.message.role !== "system")) {
    return { ok: false, message: "Nothing to export yet." };
  }
  const format = file ? formatForPath(file) : "md";
  const target = file || defaultTranscriptName(session, format);
  const written = writeTranscript(
    target,
    renderTranscript(session, { format, includeReasoning }),
    force,
  );
  return written.ok
    ? {
        ok: true,
        message: `Exported a masked transcript to ${written.path}. Masking is best effort; read it before you share it.`,
      }
    : { ok: false, message: written.error };
}
