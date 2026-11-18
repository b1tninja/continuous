import { isPosixShell, type ShellKind } from "../../util/shell";

/**
 * The command graph (plans/command-analysis.md, P2): what a command is once the
 * shell's syntax is out of the way. A list of commands, each a program and its
 * words with quotes removed, and the operator that joins each to the next.
 * Redirects that throw output away are dropped; any other redirect, any
 * expansion, group or construct the scanner does not fully understand makes
 * the whole command "not understood", with a reason, and nothing is built.
 *
 * One front end per shell family produces it. Being sure of a command means
 * being sure of what its shell makes of it, so each front end follows its own
 * shell's grammar (see the comments on each).
 */
export type JoinOperator = "|" | "&&" | "||" | ";" | "&";

export interface GraphCommand {
  /** The program, then its arguments: quotes removed, nothing expanded */
  words: string[];
}

export interface CommandGraph {
  commands: GraphCommand[];
  /** joins[i] joins commands[i] to commands[i + 1] */
  joins: JoinOperator[];
}

export type ScanResult =
  { ok: true; graph: CommandGraph } | { ok: false; why: string };

const fail = (why: string): ScanResult => ({ ok: false, why });

/** Redirects that throw output away; every other redirect is not understood. */
const POSIX_DISCARD = /^(2?>\s*\/dev\/null|2>&1)(?=$|[\s|;&])/;
const POWERSHELL_DISCARD = /^(\d?>\s*\$null|2>&1)(?=$|[\s|;&])/;
const CMD_DISCARD = /^(2?>\s*nul|2>&1)(?=$|[\s|&])/i;

/**
 * PowerShell reads curly quotes as quotes (U+2018 to U+201E), an en dash, em
 * dash or horizontal bar as the dash of a parameter, and any Unicode space as
 * a space. This scanner knows the ASCII ones only, so curly double quotes
 * around a `'`, then `; Remove-Item x ;`, then the same again would be one
 * quoted word here and three commands there. A command holding one, anywhere,
 * is not understood.
 */
const POWERSHELL_LOOKALIKE =
  /[\u2018-\u201f\u2013-\u2015\u00a0\u0085\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\v\f]/;

/**
 * Scans a command in the grammar of the shell that will run it. POSIX
 * shells and PowerShell share one scanner with different rules; cmd has its
 * own, because `%VAR%` is expanded before cmd parses anything.
 */
export function scanCommand(command: string, shell: ShellKind): ScanResult {
  if (shell === "powershell" && POWERSHELL_LOOKALIKE.test(command)) {
    return fail("a character PowerShell reads as a quote, a dash or a space");
  }
  if (isPosixShell(shell) || shell === "powershell") {
    return scanSimple(command, shell);
  }
  if (shell === "cmd") return scanCmd(command);
  return fail("this shell is not parsed");
}

/** In a POSIX shell, NAME=value before a command sets its environment. */
function envPrefixOf(words: string[], posix: boolean): string | undefined {
  if (posix) {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])
      ? "an environment prefix"
      : undefined;
  }
  // PowerShell's dot-source operator runs a script in the current scope
  return words[0] === "." ? "dot-sourcing is not understood" : undefined;
}

function scanSimple(command: string, shell: ShellKind): ScanResult {
  const powershell = shell === "powershell";
  const discard = powershell ? POWERSHELL_DISCARD : POSIX_DISCARD;
  const commands: GraphCommand[] = [];
  const joins: JoinOperator[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let trailingOperator = false;
  let i = 0;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (op: JoinOperator): string | undefined => {
    endWord();
    if (words.length === 0) return `an empty command before ${op}`;
    const prefix = envPrefixOf(words, !powershell);
    if (prefix) return prefix;
    commands.push({ words });
    joins.push(op);
    words = [];
    trailingOperator = true;
    return undefined;
  };
  const startsWord = (text: string) => {
    word += text;
    inWord = true;
    trailingOperator = false;
  };

  while (i < command.length) {
    const c = command[i];
    if (!inWord) {
      const redirect = discard.exec(command.slice(i));
      if (redirect) {
        i += redirect[0].length;
        continue;
      }
    }
    // In a POSIX shell a backslash escapes what follows (`\\'` is a quote
    // that does not start one), so a scanner that reads it as a letter and one
    // that reads it as an escape see different commands. In PowerShell it is
    // a path separator.
    if (c === "\\" && !powershell) {
      return fail("a backslash escape is not understood");
    }
    // zsh expands =cmd to the path of cmd
    if (c === "=" && shell === "zsh" && !inWord) {
      return fail("=word expansion (zsh) is not understood");
    }
    // PowerShell's splat and array operator
    if (c === "@" && powershell) return fail('"@" is not understood');

    if (c === "'") {
      let j = i + 1;
      let body = "";
      for (;;) {
        const end = command.indexOf("'", j);
        if (end < 0) return fail("an unterminated quote");
        body += command.slice(j, end);
        // PowerShell writes a quote inside single quotes by doubling it
        if (powershell && command[end + 1] === "'") {
          body += "'";
          j = end + 2;
          continue;
        }
        i = end + 1;
        break;
      }
      startsWord(body);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let body = "";
      for (;;) {
        if (j >= command.length) return fail("an unterminated quote");
        const d = command[j];
        if (d === "$" || d === "`" || (d === "\\" && !powershell)) {
          return fail(
            "a variable, substitution or escape inside double quotes",
          );
        }
        if (d === '"') {
          // PowerShell writes a quote inside double quotes by doubling it
          if (powershell && command[j + 1] === '"') {
            body += '"';
            j += 2;
            continue;
          }
          break;
        }
        body += d;
        j++;
      }
      i = j + 1;
      startsWord(body);
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "|" || c === ";" || c === "&") {
      const two = command.slice(i, i + 2);
      // A lone & starts a background job, or is PowerShell's call operator
      if (c === "&" && two !== "&&") {
        return fail(
          powershell ? "the call operator (&)" : "a background job (&)",
        );
      }
      const op = (two === "||" || two === "&&" ? two : c) as JoinOperator;
      // Windows PowerShell 5.1 is the shell on Windows and has no && or ||:
      // it reports a syntax error, so the text is not a command there
      if (powershell && (op === "&&" || op === "||")) {
        return fail(
          `${op} exists only in PowerShell 7, not in Windows PowerShell`,
        );
      }
      const err = endCommand(op);
      if (err) return fail(err);
      i += op.length;
      continue;
    }
    if (c === ">" || c === "<") {
      return fail("a redirect that is not to nowhere");
    }
    if (c === "\n" || c === "\r") return fail("a newline is not understood");
    if ("$`(){}!#".includes(c)) return fail(`"${c}" is not understood`);
    startsWord(c);
    i++;
  }
  endWord();
  // A command that ends on an operator is not finished
  if (trailingOperator && words.length === 0) {
    return fail("the command ends on an operator");
  }
  if (words.length) {
    const prefix = envPrefixOf(words, !powershell);
    if (prefix) return fail(prefix);
    commands.push({ words });
  }
  if (commands.length === 0) return fail("an empty command");
  return {
    ok: true,
    graph: { commands, joins: joins.slice(0, commands.length - 1) },
  };
}

/**
 * cmd. `%VAR%` is expanded before the line is parsed, so the text is not the
 * command, and `^` escapes, `!VAR!` expands late, `( )` group, `=` `,` `;` are
 * argument delimiters. None of that is understood: a plain program and
 * literal words, joined by `&`, `&&`, `||` or `|`, is.
 */
function scanCmd(command: string): ScanResult {
  const commands: GraphCommand[] = [];
  const joins: JoinOperator[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let trailingOperator = false;
  let i = 0;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  while (i < command.length) {
    const c = command[i];
    if (!inWord) {
      const redirect = CMD_DISCARD.exec(command.slice(i));
      if (redirect) {
        i += redirect[0].length;
        continue;
      }
    }
    if (c === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return fail("an unterminated quote");
      const body = command.slice(i + 1, end);
      if (/[%!^]/.test(body)) return fail("an expansion inside quotes");
      word += body;
      inWord = true;
      trailingOperator = false;
      i = end + 1;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "&" || c === "|") {
      const two = command.slice(i, i + 2);
      const op = (two === "&&" || two === "||" ? two : c) as JoinOperator;
      endWord();
      if (words.length === 0) return fail(`an empty command before ${op}`);
      commands.push({ words });
      joins.push(op);
      words = [];
      trailingOperator = true;
      i += op.length;
      continue;
    }
    if ("%!^()<>=,;".includes(c)) {
      return fail(
        c === "%" || c === "!"
          ? "an expansion (cmd expands it before it parses)"
          : `"${c}" is not understood`,
      );
    }
    if (c === "\n" || c === "\r") return fail("a newline is not understood");
    word += c;
    inWord = true;
    trailingOperator = false;
    i++;
  }
  endWord();
  if (trailingOperator && words.length === 0) {
    return fail("the command ends on an operator");
  }
  if (words.length) commands.push({ words });
  if (commands.length === 0) return fail("an empty command");
  return {
    ok: true,
    graph: { commands, joins: joins.slice(0, commands.length - 1) },
  };
}
