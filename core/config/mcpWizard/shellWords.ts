/*
  A small, pure tokeniser for command lines pasted from a README. It only
  splits text into words and operators so the wizard can read what a line
  would start; it never expands variables, globs or substitutions, and the
  result is never handed to a shell. Safe for code the GUI bundles.
*/

export type ShellToken = string | { op: string };

export function isOp(t: ShellToken | undefined): t is { op: string } {
  return typeof t === "object" && t !== null;
}

const OPS = ["&&", "||", "|", ";", "&", ">>", ">", "<"];

/**
 * Split one logical line into words and operators. Quotes follow POSIX:
 * single quotes are literal, double quotes keep `\` except before `"`, `\`,
 * `$` and a backtick. Outside quotes a backslash escapes the next character,
 * except in a line that looks like a Windows path (`C:\`), where it is kept.
 * A `#` at the start of a word starts a comment.
 */
export function tokenizeShellLine(line: string): ShellToken[] {
  const windowsPaths = /(^|[\s"'=])[A-Za-z]:\\/.test(line);
  const out: ShellToken[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) out.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length) {
          const n = line[j + 1];
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            word += n;
            j++;
            continue;
          }
        }
        word += line[j];
      }
      i = j;
      continue;
    }
    if (c === "\\" && !windowsPaths && i + 1 < line.length) {
      word += line[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      flush();
      continue;
    }
    if (c === "#" && !inWord) break;
    const op = OPS.find((o) => line.startsWith(o, i));
    if (op) {
      // `2>` and `2>&1`: the digit belongs to the redirection
      if ((op === ">" || op === ">>") && word === "2" && inWord) {
        word = "";
        inWord = false;
      } else {
        flush();
      }
      out.push({ op });
      i += op.length - 1;
      continue;
    }
    word += c;
    inWord = true;
  }
  flush();
  return out;
}

/** The words of each simple command, split at `&&`, `||`, `;`, `|` and `&`. */
export function splitSegments(tokens: ShellToken[]): {
  words: string[];
  /** The operator after this segment, if any */
  join?: string;
}[] {
  const segs: { words: string[]; join?: string }[] = [{ words: [] }];
  let skipNext = false;
  for (const t of tokens) {
    if (isOp(t)) {
      if (t.op === ">" || t.op === ">>" || t.op === "<") {
        skipNext = true; // the redirection target is not a word of the command
        continue;
      }
      segs[segs.length - 1].join = t.op;
      segs.push({ words: [] });
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    segs[segs.length - 1].words.push(t);
  }
  return segs.filter((s) => s.words.length > 0);
}

/**
 * Join words into one display line, quoting a word only when it needs it.
 * Used to show a command and to hand it to the string-based checks; never
 * run.
 */
export function joinShellWords(words: string[]): string {
  return words
    .map((w) => {
      if (w === "") return "''";
      if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(w)) return w;
      return `'${w.replace(/'/g, `'\\''`)}'`;
    })
    .join(" ");
}

/**
 * Lines of pasted shell text with continuations joined: a trailing `\`
 * (POSIX), a backtick (PowerShell) or `^` (cmd) carries the line on.
 */
export function logicalLines(text: string): string[] {
  const joined = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]*(?:\\|`|\^)\n[ \t]*/g, " ");
  return joined.split("\n");
}
