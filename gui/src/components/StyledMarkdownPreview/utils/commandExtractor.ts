/**
 * A shell prompt at the start of a line: `$ `, `> `, or PowerShell's
 * `PS C:\path> `. A `$` must be followed by whitespace, or `$env:TEMP` (a
 * PowerShell variable) would be read as a prompt.
 */
const PROMPT = /^\s*(?:PS [^>\n]*>|\$|>)\s+/;

/** A line that goes on onto the next: `\` (POSIX shells) or a backtick (PowerShell). */
const EXPLICIT_CONTINUATION = /\s*(?:\\|`)$/;

/** A line whose command needs the next line: it ends in `&&`, `||` or `|`. */
const OPERATOR_CONTINUATION = /(?:&&|\|\||\|)$/;

/**
 * Separates commands that were on lines of their own. Sending a newline runs
 * a line at once, so a block of several commands is joined into one line.
 * `;` separates commands in PowerShell, bash, zsh and fish.
 */
export const COMMAND_SEPARATOR = "; ";

/**
 * Collapses runs of spaces and tabs to one space, except inside single or
 * double quotes, where spacing is part of the argument.
 */
export function collapseSpacesOutsideQuotes(text: string): string {
  let out = "";
  let quote: string | undefined;
  let lastWasSpace = false;
  for (const ch of text) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      lastWasSpace = false;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (!lastWasSpace) out += " ";
      lastWasSpace = true;
      continue;
    }
    out += ch;
    lastWasSpace = false;
  }
  return out;
}

/**
 * The command a code block runs when its Run button is pressed, as one line.
 * Removes comment lines, block comments and shell prompts, joins continued
 * lines, and joins separate commands with `; `. The text of each command is
 * kept as written (spaces inside quotes included).
 *
 * @param cmd The code block's text
 * @returns The command to type into the terminal, or "" when there is none
 */
export function extractCommand(cmd: string): string {
  if (!cmd || cmd.trim() === "") {
    return "";
  }

  // Remove multi-line comments (/* ... */) and replace with a single space
  const withoutBlockComments = cmd.replace(/\/\*[\s\S]*?\*\//g, " ");

  const lines = withoutBlockComments
    .split(/\r?\n/)
    .map((line) => line.replace(PROMPT, ""))
    .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
    .map((line) => line.trim())
    .filter((line) => line);

  const commands: string[] = [];
  let current = "";
  for (const line of lines) {
    current = current ? `${current} ${line}` : line;
    if (EXPLICIT_CONTINUATION.test(current)) {
      current = current.replace(EXPLICIT_CONTINUATION, "");
      continue;
    }
    if (OPERATOR_CONTINUATION.test(current)) {
      continue;
    }
    commands.push(current.replace(/[ \t]+$/, ""));
    current = "";
  }
  if (current) {
    commands.push(current.replace(/[ \t]+$/, ""));
  }

  return commands
    .map((c) =>
      collapseSpacesOutsideQuotes(
        c.replace(/(?:\s*(?:&&|\|\||\|))+$/, ""),
      ).trim(),
    )
    .filter((c) => c)
    .join(COMMAND_SEPARATOR);
}
