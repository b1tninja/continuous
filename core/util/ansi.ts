/**
 * Terminal control sequences in a command's output.
 *
 * Tools colour their output when they think a person is watching, and the
 * escape codes cost the model tokens and add noise (two lines that read the
 * same differ by their colour codes, so a repeated line is not noticed as
 * repeated). The model gets the text without them. The screen keeps the raw
 * text so colour still shows.
 *
 * Only escape sequences are removed. Newlines, tabs and carriage returns stay:
 * a carriage return is how a progress bar redraws, and compressProgress
 * (commandOutputBuffer.ts) handles it.
 */

const ESC = "\u001b";
const CSI_8BIT = "\u009b";
const OSC_8BIT = "\u009d";

/**
 * One sequence:
 * - CSI: ESC [ (or the 8-bit form), parameter bytes 0x30-0x3F, intermediate
 *   bytes 0x20-0x2F, one final byte 0x40-0x7E (colours, cursor moves, erase).
 * - OSC: ESC ] (or the 8-bit form) up to BEL or the string terminator ESC \
 *   (window titles, hyperlinks). One with no terminator ends where the next
 *   escape starts.
 * - DCS, SOS, PM, APC strings: ESC P / X / ^ / _ up to the string terminator,
 *   or up to the next escape.
 * - Any other escape: ESC, optional intermediate bytes 0x20-0x2F, one final
 *   byte (character-set selects, ESC c reset, ESC 7 / 8 save and restore). The
 *   final byte is never one of the introducers [ ] P X ^ _, which start a
 *   longer sequence above: taking "ESC [" as a whole escape would leave the
 *   rest of a cut-off CSI behind as text.
 */
const GENERIC_FINAL = "[0-9:;<=>?@A-OQ-WYZ\\\\`a-z{|}~]";
const SEQUENCE = new RegExp(
  [
    `(?:${ESC}\\[|${CSI_8BIT})[0-?]*[ -/]*[@-~]`,
    `(?:${ESC}\\]|${OSC_8BIT})[^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`,
    `(?:${ESC}\\]|${OSC_8BIT})[^\\u0007${ESC}]*(?=${ESC})`,
    `${ESC}[P^_X][^${ESC}]*${ESC}\\\\`,
    `${ESC}[P^_X][^${ESC}]*(?=${ESC})`,
    `${ESC}[ -/]*${GENERIC_FINAL}`,
  ].join("|"),
  "g",
);

/**
 * An escape sequence cut off at the end of the text (the output was cut in
 * the middle of one): dropped, so no half sequence is left as visible junk.
 */
const TRAILING_PARTIAL = new RegExp(
  [
    `(?:${ESC}|${CSI_8BIT})\\[?[0-?]*[ -/]*$`,
    `(?:${ESC}\\]|${OSC_8BIT})[^\\u0007${ESC}]*${ESC}?$`,
    `${ESC}[P^_X][^${ESC}]*${ESC}?$`,
    `${ESC}$`,
  ].join("|"),
);

/** True when the text holds a terminal escape sequence. */
export function hasAnsi(text: string): boolean {
  if (!text) return false;
  if (
    !text.includes(ESC) &&
    !text.includes(CSI_8BIT) &&
    !text.includes(OSC_8BIT)
  ) {
    return false;
  }
  SEQUENCE.lastIndex = 0;
  const found = SEQUENCE.test(text);
  SEQUENCE.lastIndex = 0;
  return found || TRAILING_PARTIAL.test(text);
}

/** The text without terminal escape sequences. */
export function stripAnsi(text: string): string {
  if (!text) return text;
  if (
    !text.includes(ESC) &&
    !text.includes(CSI_8BIT) &&
    !text.includes(OSC_8BIT)
  ) {
    return text;
  }
  return text.replace(SEQUENCE, "").replace(TRAILING_PARTIAL, "");
}
