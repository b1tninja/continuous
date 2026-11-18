/**
 * The one set of hidden characters: code points that render as nothing (or
 * nearly nothing) yet reach a model as text. Every place that strips, redacts
 * or flags them reads this module, so a character added here is handled the
 * same way by the fetched-page cleaner (`fetchedText.ts`), the reviewer
 * guidance (`auto/guidance.ts`), the spotlight token redaction
 * (`spotlight.ts`) and the injection detector (`injection.ts`). Those four
 * used to keep four different lists.
 *
 * Pure, no Node imports: the webview imports it.
 */

/**
 * Soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers,
 * Khmer inherent vowels, Mongolian free variation selectors and vowel
 * separator, zero-width and direction marks, bidi embeddings and overrides,
 * word joiner and invisible operators, bidi isolates and the deprecated format
 * characters, variation selectors, BOM, halfwidth Hangul filler, interlinear
 * annotation, and (separately, below) the Unicode tag block.
 */
const HIDDEN_BMP =
  "\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB";
/** The tag block (U+E0000 to U+E007F), which can spell ASCII that renders as nothing. */
const TAGS = "\\u{E0000}-\\u{E007F}";

/** Every hidden character, tags included. Global: use with `replace`. */
export const HIDDEN_CHARACTERS = new RegExp(`[${HIDDEN_BMP}${TAGS}]`, "gu");

/** Every hidden character except the tag block, for a caller that decodes tags first. */
export const HIDDEN_CHARACTERS_EXCEPT_TAGS = new RegExp(
  `[${HIDDEN_BMP}]`,
  "gu",
);

/**
 * The subset that hides or reorders text rather than only splitting a word:
 * tag characters and bidirectional embeddings, overrides and isolates. The
 * injection detector flags output that contains one (`hidden-unicode`).
 */
export const SMUGGLING_CHARACTERS = /[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/u;

/** Remove every hidden character. */
export function stripHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, "");
}

/** Whether the text contains a tag or bidi control character. */
export function hasSmugglingCharacters(text: string): boolean {
  return SMUGGLING_CHARACTERS.test(text);
}
