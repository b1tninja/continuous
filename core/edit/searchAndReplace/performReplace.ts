import { EditOperation } from "../../tools/definitions/multiEdit";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { SearchMatchResult, findSearchMatches } from "./findSearchMatch";
import { recoverMatch } from "./recoverMatch";
import { strippedFirstLineShift } from "./strippedIndent";

/**
 * Get the leading whitespace of the first non-empty line in a string.
 */
function getLeadingIndent(text: string): string {
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim().length > 0) {
      const match = line.match(/^(\s*)/);
      return match ? match[1] : "";
    }
  }
  return "";
}

/**
 * Get the indentation of the file line containing a given character position.
 */
function getLineIndentAtPosition(
  fileContent: string,
  position: number,
): string {
  const lineStart = fileContent.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = fileContent.indexOf("\n", lineStart);
  const line = fileContent.substring(
    lineStart,
    lineEnd === -1 ? fileContent.length : lineEnd,
  );
  const match = line.match(/^(\s*)/);
  return match ? match[1] : "";
}

/**
 * When a fuzzy match strategy (trimmedMatch, whitespaceIgnoredMatch, etc.)
 * finds a match, the indentation of the matched region in the file may
 * differ from the indentation in the search string provided by the LLM.
 * This function adjusts newString so its indentation is relative to the
 * actual matched text in the file rather than the LLM-provided oldString.
 */
function adjustReplacementIndentation(
  fileContent: string,
  match: SearchMatchResult,
  oldString: string,
  newString: string,
): string {
  if (
    match.strategyName === "exactMatch" ||
    match.strategyName === "emptySearch"
  ) {
    return newString;
  }

  const matchedIndent = getLineIndentAtPosition(fileContent, match.startIndex);
  const oldIndent = getLeadingIndent(oldString);

  // old_string lost the indentation of its first line (vLLM issue 48753): the
  // later lines move by what the file adds to them, not by the match's indent.
  const shift = strippedFirstLineShift(fileContent, match, oldString);
  if (shift !== undefined) {
    return newString
      .split("\n")
      .map((line, index) =>
        index === 0 || line.trim().length === 0 ? line : shift + line,
      )
      .join("\n");
  }

  if (matchedIndent === oldIndent) {
    return newString;
  }

  const lines = newString.split("\n");
  const adjusted = lines.map((line, index) => {
    if (line.trim().length === 0) {
      return line;
    }
    if (index === 0) {
      // First line: the file content before startIndex already provides
      // indentation, so strip the old indent rather than adding new
      if (oldIndent && line.startsWith(oldIndent)) {
        return line.slice(oldIndent.length);
      }
      return line;
    }
    // Subsequent lines: replace oldIndent prefix with matchedIndent
    if (line.startsWith(oldIndent)) {
      return matchedIndent + line.slice(oldIndent.length);
    }
    return line;
  });
  return adjusted.join("\n");
}

/** Count CRLF and bare LF line breaks in a string. */
function countLineEndings(text: string): { crlf: number; lf: number } {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { crlf, lf };
}

/**
 * Make newString's line breaks agree with the file region it replaces.
 * A region that is all CRLF (or all LF) decides. A region with no line break
 * (a single-line match, or an insertion) defers to the file's majority ending.
 * A mixed region keeps each of its own endings when newString has the same
 * number of breaks, and otherwise follows the region's majority.
 * Only line breaks inside newString change, so whether the file ends with a
 * newline is never touched.
 */
function fitLineEndings(
  fileContent: string,
  match: SearchMatchResult,
  newString: string,
): string {
  if (!newString.includes("\n")) {
    return newString;
  }
  const matched = fileContent.slice(match.startIndex, match.endIndex);
  const region = countLineEndings(matched);
  const normalised = newString.replace(/\r\n/g, "\n");
  if (region.crlf > 0 && region.lf > 0) {
    const regionEndings = matched.match(/\r?\n/g)!;
    const parts = normalised.split("\n");
    if (parts.length - 1 === regionEndings.length) {
      return parts.reduce(
        (out, part, i) =>
          out + part + (i < parts.length - 1 ? regionEndings[i] : ""),
        "",
      );
    }
  }
  const counts =
    region.crlf + region.lf > 0 ? region : countLineEndings(fileContent);
  return counts.crlf > counts.lf
    ? normalised.replace(/\n/g, "\r\n")
    : normalised;
}

/**
 * The fuzzy strategies end a match at the last non-whitespace character, so an
 * old_string that ends with a line break matches a region without it, and the
 * line break new_string ends with then lands after the file's own, doubling it.
 * Take the file's line break into the match so the two cancel.
 */
function includeTrailingLineBreak(
  fileContent: string,
  match: SearchMatchResult,
  oldString: string,
): SearchMatchResult {
  if (
    match.strategyName === "exactMatch" ||
    match.strategyName === "emptySearch" ||
    !/\n$/.test(oldString) ||
    fileContent[match.endIndex - 1] === "\n"
  ) {
    return match;
  }
  const rest = fileContent.slice(match.endIndex, match.endIndex + 2);
  const lineBreak = /^\r?\n/.exec(rest);
  return lineBreak
    ? { ...match, endIndex: match.endIndex + lineBreak[0].length }
    : match;
}

export function executeFindAndReplace(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  editIndex = 0,
): string {
  const matches = findSearchMatches(fileContent, oldString);

  if (matches.length === 0) {
    // No existing strategy matched. A single unambiguous recovered location is
    // applied (one occurrence only, so never with replace_all); anything else
    // is an error that says where old_string diverged.
    const recovered = recoverMatch(fileContent, oldString, newString);
    if (recovered.ok && !replaceAll) {
      const m = recovered.match;
      return (
        fileContent.substring(0, m.startIndex) +
        m.newString +
        fileContent.substring(m.endIndex)
      );
    }
    const detail = recovered.ok
      ? "A near match exists, but replace_all needs an exact string; copy the lines exactly."
      : recovered.message;
    throw new ContinueError(
      recovered.ok || recovered.reason === "notFound"
        ? ContinueErrorReason.FindAndReplaceOldStringNotFound
        : ContinueErrorReason.FindAndReplaceMultipleOccurrences,
      `Edit at index ${editIndex}: string not found in file: "${oldString}"\n${detail}`,
    );
  }

  if (replaceAll) {
    // Apply replacements in reverse order to maintain correct positions
    let result = fileContent;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = includeTrailingLineBreak(result, matches[i], oldString);
      const adjustedNew = adjustReplacementIndentation(
        result,
        match,
        oldString,
        newString,
      );
      result =
        result.substring(0, match.startIndex) +
        fitLineEndings(result, match, adjustedNew) +
        result.substring(match.endIndex);
    }
    return result;
  } else {
    // For single replacement, check for multiple matches first
    if (matches.length > 1) {
      throw new ContinueError(
        ContinueErrorReason.FindAndReplaceMultipleOccurrences,
        `Edit at index ${editIndex}: String "${oldString}" appears ${matches.length} times in the file. Either provide a more specific string with surrounding context to make it unique, or use replace_all=true to replace all occurrences.`,
      );
    }

    // Apply single replacement
    const match = includeTrailingLineBreak(fileContent, matches[0], oldString);
    const adjustedNew = adjustReplacementIndentation(
      fileContent,
      match,
      oldString,
      newString,
    );
    return (
      fileContent.substring(0, match.startIndex) +
      fitLineEndings(fileContent, match, adjustedNew) +
      fileContent.substring(match.endIndex)
    );
  }
}

export function executeMultiFindAndReplace(
  fileContent: string,
  edits: EditOperation[],
): string {
  let result = fileContent;

  // Apply edits in sequence
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex];
    result = executeFindAndReplace(
      result,
      edit.old_string,
      edit.new_string,
      edit.replace_all ?? false,
      editIndex,
    );
  }

  return result;
}
