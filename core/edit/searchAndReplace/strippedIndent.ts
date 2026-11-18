/**
 * Indentation of the lines after the first, when old_string arrived with the
 * indentation of its first line stripped.
 *
 * vLLM's Qwen3 and Qwen3-Coder tool parser strips leading and trailing
 * whitespace from every string argument (vLLM issue 48753), so a block the
 * model copied at indentation 4 reaches us as "if x:\n        y()": the first
 * line has lost its four spaces and the later lines have kept theirs. When the
 * file holds the block at indentation 8, the exact search fails and the
 * whitespace-ignored one finds it, and the later lines of new_string must
 * move by the real difference between the file and old_string (4), not by the
 * indentation of the file line the match starts on (8): that would put every
 * later line four columns too deep.
 */

const indentOf = (s: string) => /^[ \t]*/.exec(s)![0];

const splitLines = (s: string) => s.split(/\r?\n/);

/**
 * The text to put in front of every non-blank line of new_string after the
 * first, or undefined when this is not the stripped-first-line case (the
 * caller keeps its ordinary rule then).
 *
 * The case is recognised only when all of these hold: old_string's first line
 * has no indentation, the match starts after the indentation of its file line
 * (so a stripped indent could explain it), at least one later line is not
 * blank, and every later non-blank line differs from the file by the same
 * added indentation (possibly none).
 */
export function strippedFirstLineShift(
  fileContent: string,
  match: { startIndex: number; endIndex: number },
  oldString: string,
): string | undefined {
  const oldLines = splitLines(oldString);
  if (oldLines.length < 2 || oldLines[0] === "" || indentOf(oldLines[0]))
    return undefined;
  const lineStart = fileContent.lastIndexOf("\n", match.startIndex - 1) + 1;
  const before = fileContent.slice(lineStart, match.startIndex);
  if (before === "" || before.trim() !== "") return undefined;
  const fileLines = splitLines(
    fileContent.slice(match.startIndex, match.endIndex),
  );
  if (fileLines.length !== oldLines.length) return undefined;

  let shift: string | undefined;
  for (let i = 1; i < oldLines.length; i++) {
    if (oldLines[i].trim() === "" && fileLines[i].trim() === "") continue;
    if (oldLines[i].trim() === "" || fileLines[i].trim() === "") {
      return undefined;
    }
    const oi = indentOf(oldLines[i]);
    const fi = indentOf(fileLines[i]);
    if (!fi.endsWith(oi)) return undefined;
    if (oldLines[i].slice(oi.length) !== fileLines[i].slice(fi.length)) {
      return undefined;
    }
    const added = fi.slice(0, fi.length - oi.length);
    if (shift !== undefined && shift !== added) return undefined;
    shift = added;
  }
  return shift;
}
