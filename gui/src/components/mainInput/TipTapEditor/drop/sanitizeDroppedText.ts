import { stripInvisible } from "core/util/fetchedText";

const JOINERS = /([‌‍])/;

/**
 * Removes hidden characters from dropped text with the existing
 * `stripInvisible` (tag characters, bidi controls, zero-width spaces, BOM, C0
 * controls), but keeps the zero-width joiner and non-joiner, which emoji
 * sequences and Persian and Indic text need. Returns the count removed.
 */
export function sanitizeDroppedText(text: string): {
  text: string;
  removed: number;
} {
  let removed = 0;
  const out = text
    .split(JOINERS)
    .map((part) => {
      if (part === "‌" || part === "‍") return part;
      const clean = stripInvisible(part);
      removed += Array.from(part).length - Array.from(clean).length;
      return clean;
    })
    .join("");
  return { text: out, removed };
}
