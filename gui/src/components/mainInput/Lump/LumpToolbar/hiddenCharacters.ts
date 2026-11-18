/**
 * Characters that are in a call but draw as nothing, or change the order the
 * text is drawn in: bidirectional controls, zero-width spaces, the byte order
 * mark, soft hyphens, Unicode tag characters and control characters. In an
 * approval they are a way to show one command and run another, so the card
 * writes each one out as its code point.
 *
 * Left as they are: a tab, a line feed, the carriage return of a CRLF line end
 * (a file edit on Windows has one per line), and the zero-width joiner and
 * non-joiner, which emoji and several scripts need to draw correctly.
 */
const CONTROL_OR_FORMAT = /\r\n|[\p{Cc}\p{Cf}]/gu;
const KEPT = new Set(["\r\n", "\n", "\t", "\u200C", "\u200D"]);

/** How a hidden character is written in the card, e.g. "⟦U+202E⟧". */
export function hiddenMark(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`;
}

export interface Revealed {
  /** The text with every hidden character written out. */
  text: string;
  /** How many were written out. */
  count: number;
}

export function revealHidden(text: string): Revealed {
  let count = 0;
  const shown = text.replace(CONTROL_OR_FORMAT, (match) => {
    if (KEPT.has(match)) return match;
    count += 1;
    return hiddenMark(match);
  });
  return { text: shown, count };
}

/** The sentence under a card that had any, or undefined. */
export function hiddenNote(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1
    ? "1 hidden character is in this call. It is written out as ⟦U+…⟧ above so you can see where it is."
    : `${count} hidden characters are in this call. They are written out as ⟦U+…⟧ above so you can see where they are.`;
}
