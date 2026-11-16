/**
 * Guards for instruction files (`AGENTS.md`, `CLAUDE.md`, rule files): what
 * is done to a file's text between reading it and putting it in the prompt.
 * ROADMAP X20, X29 and the D-107 cap; decisions in
 * plans/decisions-2026-11-15.md and plans/implementation-waves-2026-11-15.md
 * (W1-E).
 *
 * - Hidden characters are removed and counted, and the person is told which
 *   file and which lines held them. The removed characters are never shown
 *   or logged. Joiners and emoji variation selectors that are part of what a
 *   reader sees are kept, so the visible text does not change.
 * - A value that looks like a credential gives a warning. The file still
 *   loads as written (X29: warn, never block).
 * - A file over 32 KiB is cut at a line boundary, and a line naming the file
 *   is added where it was cut (not refused).
 *
 * The IDE (`loadMarkdownRules.ts`) and the CLI (`extensions/cli`) both call
 * `guardInstructionFile`, so one file gives the same text on both.
 *
 * Also here: the session state for an IDE that withholds `AGENTS.md` in an
 * untrusted workspace (VS Code's Restricted Mode). Pure, no Node imports.
 */
import { HIDDEN_CHARACTERS } from "../../util/hiddenCharacters";
import { scanText } from "../../util/secretScan";

/** Most bytes (UTF-8) of one instruction file that are loaded. */
export const INSTRUCTION_FILE_CAP_BYTES = 32 * 1024;

export type InstructionFileNoticeKind = "hidden-characters" | "secret" | "cut";

export interface InstructionFileNotice {
  kind: InstructionFileNoticeKind;
  /** The file's path or URI, for opening it. */
  file: string;
  /** The file's name, for the message. */
  name: string;
  /** One sentence or two for the person. Never holds the hidden text or the secret. */
  message: string;
}

export type HiddenCharacterClass =
  "zero-width" | "bidi" | "tag" | "variation-selector" | "other";

export interface HiddenCharacterReport {
  /** The text without the hidden characters. */
  text: string;
  /** How many were removed (a leading byte order mark is not counted). */
  removed: number;
  byClass: Partial<Record<HiddenCharacterClass, number>>;
  /** The 1-based lines that held one, in order. */
  lines: number[];
}

const HIDDEN = new RegExp(HIDDEN_CHARACTERS.source, "u");
/** Variation selectors 17 to 256, which the shared set does not list. */
const SUPPLEMENTARY_VS = /[\u{E0100}-\u{E01EF}]/u;
const VARIATION_SELECTOR =
  /[\uFE00-\uFE0F\u180B-\u180D\u180F\u{E0100}-\u{E01EF}]/u;
const JOINER = /[\u200C\u200D]/u;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const ZERO_WIDTH = /[\u00AD\u034F\u180E\u200B-\u200D\u2060-\u2064\uFEFF]/u;
const TAG = /[\u{E0000}-\u{E007F}]/u;
/** Tag characters that may follow U+1F3F4 in an emoji tag sequence (a subdivision flag). */
const TAG_SPEC = /[\u{E0020}-\u{E007E}]/u;
const CANCEL_TAG = "\u{E007F}";
const BLACK_FLAG = "\u{1F3F4}";

function isHidden(ch: string): boolean {
  return HIDDEN.test(ch) || SUPPLEMENTARY_VS.test(ch);
}

/** A character a reader sees: not hidden and not white space. */
function isBase(ch: string | undefined): boolean {
  return ch !== undefined && !isHidden(ch) && !/\s/u.test(ch);
}

function classOf(ch: string): HiddenCharacterClass {
  if (TAG.test(ch)) return "tag";
  if (BIDI.test(ch)) return "bidi";
  if (VARIATION_SELECTOR.test(ch)) return "variation-selector";
  if (ZERO_WIDTH.test(ch)) return "zero-width";
  return "other";
}

/**
 * Remove the hidden characters from an instruction file, keeping the ones
 * that change what a reader sees:
 *
 * - one variation selector directly after a visible character (an emoji
 *   shown as a picture, `U+FE0F`, or a CJK variant); a second one in a row
 *   is removed, since a run of them can spell bytes;
 * - a zero-width joiner or non-joiner between two visible characters (emoji
 *   sequences, Persian and Indic text); one next to white space or another
 *   hidden character is removed;
 * - the tag characters of an emoji tag sequence (`U+1F3F4`, tags, `U+E007F`:
 *   the flags of England, Scotland and Wales); any other tag is removed;
 * - a byte order mark at the very start is removed without being counted.
 */
export function stripHiddenInstructionCharacters(
  text: string,
): HiddenCharacterReport {
  const chars = Array.from(text);
  const out: string[] = [];
  const byClass: Partial<Record<HiddenCharacterClass, number>> = {};
  const lines: number[] = [];
  let removed = 0;
  let line = 1;
  // What the last kept character allows next
  let vsAllowed = false;
  let joinerAllowed = false;

  const drop = (ch: string) => {
    removed++;
    const cls = classOf(ch);
    byClass[cls] = (byClass[cls] ?? 0) + 1;
    if (lines[lines.length - 1] !== line) lines.push(line);
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") line++;
    if (!isHidden(ch)) {
      out.push(ch);
      vsAllowed = joinerAllowed = isBase(ch);
      if (ch === BLACK_FLAG) {
        let j = i + 1;
        while (j < chars.length && TAG_SPEC.test(chars[j])) j++;
        if (j > i + 1 && chars[j] === CANCEL_TAG) {
          out.push(...chars.slice(i + 1, j + 1));
          i = j;
          vsAllowed = false;
        }
      }
      continue;
    }
    if (i === 0 && ch === "\uFEFF") continue;
    if (VARIATION_SELECTOR.test(ch) && vsAllowed) {
      out.push(ch);
      vsAllowed = false;
      continue;
    }
    if (JOINER.test(ch) && joinerAllowed && isBase(chars[i + 1])) {
      out.push(ch);
      vsAllowed = joinerAllowed = false;
      continue;
    }
    drop(ch);
  }
  return { text: out.join(""), removed, byClass, lines };
}

const CLASS_WORDS: Record<HiddenCharacterClass, string> = {
  "zero-width": "zero-width",
  bidi: "text-direction",
  tag: "tag",
  "variation-selector": "variation selector",
  other: "other invisible",
};

function lineList(lines: number[]): string {
  const shown = lines.slice(0, 5).join(", ");
  const more = lines.length > 5 ? ` and ${lines.length - 5} more` : "";
  return `${lines.length === 1 ? "line" : "lines"} ${shown}${more}`;
}

export interface CutReport {
  text: string;
  /** Set when the file was longer than the cap. */
  cut?: { totalBytes: number; keptBytes: number; keptLines: number };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Cut `text` to at most `cap` UTF-8 bytes, after the last whole line that
 * fits. A first line longer than the cap is cut at the last whole character.
 */
export function capInstructionText(
  text: string,
  cap: number = INSTRUCTION_FILE_CAP_BYTES,
): CutReport {
  const bytes = encoder.encode(text);
  if (bytes.length <= cap) return { text };
  let end = bytes.lastIndexOf(0x0a, cap - 1) + 1;
  if (end === 0) {
    end = cap;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  }
  const kept = decoder.decode(bytes.subarray(0, end));
  const keptLines = kept.split("\n").length - (kept.endsWith("\n") ? 1 : 0);
  return {
    text: kept,
    cut: { totalBytes: bytes.length, keptBytes: end, keptLines },
  };
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}

/** The last path segment of a path or URI. */
export function instructionFileName(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] || file;
}

export interface GuardedInstructionFile {
  /** The text to load: hidden characters removed, cut at the cap. */
  content: string;
  notices: InstructionFileNotice[];
}

/**
 * The text of one instruction file as it is loaded, and what the person is
 * told about it. `file` is its path or URI.
 */
export function guardInstructionFile(
  file: string,
  raw: string,
): GuardedInstructionFile {
  const name = instructionFileName(file);
  const notices: InstructionFileNotice[] = [];

  const hidden = stripHiddenInstructionCharacters(raw);
  if (hidden.removed > 0) {
    const parts = (Object.keys(CLASS_WORDS) as HiddenCharacterClass[])
      .filter((c) => hidden.byClass[c])
      .map((c) => `${hidden.byClass[c]} ${CLASS_WORDS[c]}`);
    notices.push({
      kind: "hidden-characters",
      file,
      name,
      message: `${name}: removed ${hidden.removed} hidden ${hidden.removed === 1 ? "character" : "characters"} (${parts.join(", ")}) on ${lineList(hidden.lines)}. Hidden characters can carry instructions you cannot see; open the file to check it.`,
    });
  }

  const capped = capInstructionText(hidden.text);
  let content = capped.text;
  if (capped.cut) {
    const { totalBytes, keptLines } = capped.cut;
    content += `${content.endsWith("\n") || content === "" ? "" : "\n"}[${name} is ${kib(totalBytes)}, over the ${kib(INSTRUCTION_FILE_CAP_BYTES)} limit for an instruction file: only lines 1 to ${keptLines} were loaded.]\n`;
    notices.push({
      kind: "cut",
      file,
      name,
      message: `${name} is ${kib(totalBytes)}, over the ${kib(INSTRUCTION_FILE_CAP_BYTES)} limit for an instruction file, so only lines 1 to ${keptLines} were loaded. Shorten it or split it into rule files.`,
    });
  }

  const findings = scanText(capped.text, "outbound", { path: file });
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((f) => f.kind))];
    const secretLines = [
      ...new Set(
        findings.map((f) => capped.text.slice(0, f.start).split("\n").length),
      ),
    ];
    notices.push({
      kind: "secret",
      file,
      name,
      message: `${name}: ${lineList(secretLines)} ${secretLines.length === 1 ? "holds" : "hold"} what looks like a secret (${kinds.join(", ")}). The file was loaded as written, and instruction files go out with every request, so move the value out of it.`,
    });
  }

  return { content, notices };
}

/** What the IDE's last config load did with instruction files. */
export interface InstructionFilesState {
  /** Agent files not read because the workspace is not trusted (Restricted Mode). */
  withheld: string[];
  notices: InstructionFileNotice[];
}

let withholdAgentFiles: (() => boolean) | undefined;
let agentFilesLoadedThisSession = false;
let lastState: InstructionFilesState = { withheld: [], notices: [] };

/**
 * Set by an IDE that withholds agent files in a workspace it does not trust
 * (VS Code: `workspace.isTrusted === false`). Without it, every agent file is
 * read, as before.
 */
export function setAgentFileGate(gate: (() => boolean) | undefined): void {
  withholdAgentFiles = gate;
}

/**
 * The one-click Load: agent files are read for the rest of this process (the
 * window's session). Nothing is written; the next window asks again.
 */
export function loadAgentFilesThisSession(): void {
  agentFilesLoadedThisSession = true;
}

/** Whether agent files are withheld now. */
export function agentFilesWithheld(): boolean {
  return !agentFilesLoadedThisSession && withholdAgentFiles?.() === true;
}

export function recordInstructionFilesState(
  state: InstructionFilesState,
): void {
  lastState = state;
}

export function getInstructionFilesState(): InstructionFilesState {
  return lastState;
}

/** For tests. */
export function resetInstructionFilesSession(): void {
  withholdAgentFiles = undefined;
  agentFilesLoadedThisSession = false;
  lastState = { withheld: [], notices: [] };
}
