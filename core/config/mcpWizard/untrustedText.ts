/*
  Text a new MCP server sends about itself (tool, prompt and resource
  descriptions) is untrusted (plans/research/mcp-server-wizard.md section
  5.1 item 7). This is the wizard's local stand-in for the shared normaliser
  of row X27 (which includes TR14's caps); when X27 lands, the probe imports
  that function instead and this file goes. Pure, safe for the GUI bundle.
*/

/** TR14's proposed cap for one description. */
export const DESCRIPTION_CAP = 1024;

export interface NormalizedText {
  text: string;
  truncated: boolean;
  /** Invisible or direction-changing characters were removed. */
  hadHiddenCharacters: boolean;
}

const HIDDEN =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
// C0 and C1 controls; tab, newline and carriage return become spaces below
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * One line of plain text: NFC, no invisible, bidirectional or control
 * characters, no HTML comments or tags, whitespace collapsed, capped at
 * `cap` characters with a trailing ellipsis.
 */
export function normalizeUntrustedText(
  raw: unknown,
  cap = DESCRIPTION_CAP,
): NormalizedText {
  if (typeof raw !== "string" || raw === "") {
    return { text: "", truncated: false, hadHiddenCharacters: false };
  }
  let text = raw.normalize("NFC");
  const hadHiddenCharacters = HIDDEN.test(text);
  HIDDEN.lastIndex = 0;
  text = text
    .replace(HIDDEN, "")
    .replace(CONTROL, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  if (chars.length <= cap)
    return { text, truncated: false, hadHiddenCharacters };
  return {
    text: chars.slice(0, cap - 1).join("") + "…",
    truncated: true,
    hadHiddenCharacters,
  };
}
