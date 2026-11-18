// Failure taxonomy and the dialect detector for the env-shell-tasks suite.
// Pure functions: no file system, no process, no network. Two jobs:
//   1. `dialectSignals(command, shell)`: what in the TEXT of a command is
//      written for another shell than `shell` (the bash-ism detector).
//   2. `classifyOutcome(...)`: what went wrong when a command ran, from its
//      exit code and output, falling back to the signals when the output
//      does not say.
// It is an independent bench-side reader: it does not import the product's
// core/tools/permissions/detectShell.ts or commandLint.ts, so the bench can
// measure those later without grading its own homework (see README).

/** The host shells a task can run on. `powershell` is Windows PowerShell 5.1. */
export const SHELLS = ["powershell", "pwsh", "cmd", "bash", "wsl"];

/** Failure classes. `ok` is not a failure. */
export const CLASSES = {
  "parse-bashism":
    "bash syntax a PowerShell 5.1 or cmd parser rejects (&&, ||, <<, VAR=x cmd, export)",
  "env-form":
    "an environment variable written in another shell's form ($NAME in PowerShell, %VAR% in PowerShell or bash, $env:X in bash)",
  "path-form":
    "a path in another host's form (/c/Users, /mnt/c, /tmp, /dev/null in PowerShell; C:\\ in bash)",
  "alias-flags":
    "a command that exists but with another shell's flags (ls -la, rm -rf, curl -s in PowerShell)",
  "tool-missing":
    "a Unix tool that the host shell does not have (grep, sed, awk, head, tail, wc, touch, which)",
  "foreign-syntax":
    "PowerShell or cmd text sent to bash (Get-ChildItem, $env:X, -eq, dir /b)",
  quoting:
    "unterminated or mangled quotes, a quote eaten by the layer above the shell",
  hang: "the command did not return (an editor, a prompt, a server in the foreground)",
  other:
    "a nonzero exit or error text none of the above explains (a real program failure)",
};

/** Classes that mean "written for the wrong shell": a translation retry follows these. */
export const DIALECT_CLASSES = new Set([
  "parse-bashism",
  "env-form",
  "path-form",
  "alias-flags",
  "tool-missing",
  "foreign-syntax",
]);

/**
 * Replace the inside of single and double quoted strings with spaces, keeping
 * the length, so a pattern for `&&` does not fire inside `git commit -m 'a && b'`.
 * PowerShell's backtick escapes and bash's backslash escapes are both read as
 * "skip the next character" inside double quotes. This is a reader for
 * detection, not a parser: an unterminated quote blanks the rest of the text.
 */
export function blankQuoted(text) {
  let out = "";
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if ((c === "\\" || c === "`") && q === '"' && i + 1 < text.length) {
        out += "  ";
        i++;
      } else if (c === q) {
        q = null;
        out += c;
      } else out += c === "\n" ? "\n" : " ";
    } else if (c === "'" || c === '"') {
      q = c;
      out += c;
    } else out += c;
  }
  return out;
}

const PS = new Set(["powershell", "pwsh"]);

// Names that are PowerShell automatic variables when written in capitals:
// not environment variables, so `$HOME` is fine in PowerShell.
const PS_AUTOMATIC = new Set([
  "HOME",
  "PWD",
  "PID",
  "PSHOME",
  "PROFILE",
  "NULL",
  "TRUE",
  "FALSE",
  "ERROR",
  "HOST",
  "ARGS",
  "INPUT",
  "MATCHES",
  "PSVERSIONTABLE",
  "LASTEXITCODE",
  "PSITEM",
  "PSSCRIPTROOT",
  "PSCOMMANDPATH",
  "OFS",
  "SHELLID",
  "STACKTRACE",
  "EVENT",
]);

const UNIX_TOOLS =
  "grep|egrep|fgrep|sed|awk|head|tail|wc|touch|which|chmod|chown|sudo|xargs|tr|cut|uniq|basename|dirname|readlink|realpath|nl|tee|diff|ln|file|stat|printenv|seq|yes|nohup|pkill|killall|lsof|df|du|tar|unzip|zip|jq|rg|fd";
const UNIX_TOOL_RE = new RegExp(
  `(?:^|[|;&(\\n])\\s*(?:${UNIX_TOOLS})(?=\\s|$)`,
  "m",
);
const CMD_START = "(?:^|[;&|\\n])\\s*";

/**
 * Each signal: code, class, the shells it is wrong in (`wrongIn`), a test on
 * the quote-blanked text (`re`, or `test(blanked, raw)`), and `certain`:
 * true when the shell's own parser rejects it every time (a pre-flight reject
 * is safe), false when it is a strong hint that may be a false alarm.
 */
const SIGNALS = [
  {
    code: "S001",
    cls: "parse-bashism",
    says: "&& or || between commands",
    wrongIn: ["powershell"],
    re: /&&|\|\|/,
    certain: true,
  },
  {
    code: "S002",
    cls: "parse-bashism",
    says: "heredoc <<",
    wrongIn: ["powershell", "cmd"],
    re: /<<-?\s*(?:'[^']*'|"[^"]*"|\\?[A-Za-z_])/,
    certain: true,
  },
  {
    code: "S003",
    cls: "parse-bashism",
    says: "export NAME=value",
    wrongIn: ["powershell", "cmd"],
    re: /(?:^|[;&|\n])\s*export\s+[A-Za-z_]\w*=?/,
    certain: false,
  },
  {
    code: "S004",
    cls: "parse-bashism",
    says: "NAME=value command prefix",
    wrongIn: ["powershell", "cmd"],
    re: /(?:^|[;&|\n])\s*[A-Za-z_][A-Za-z0-9_]*=[^\s=]*\s+[A-Za-z./]/,
    certain: false,
  },
  {
    code: "S005",
    cls: "parse-bashism",
    says: "$( ) command substitution in cmd",
    wrongIn: ["cmd"],
    re: /\$\(/,
    certain: false,
  },
  {
    code: "S006",
    cls: "parse-bashism",
    says: "bash test [[ ]]",
    wrongIn: ["powershell", "cmd"],
    re: /\[\[\s/,
    certain: true,
  },
  {
    code: "S007",
    cls: "parse-bashism",
    says: "if ...; then ... fi, for ... do ... done",
    wrongIn: ["powershell", "cmd"],
    re: /;\s*then\b|;\s*do\b|(?:^|[;\n])\s*(?:fi|done)\s*(?:$|[;&|])/m,
    certain: true,
  },
  {
    code: "S008",
    cls: "parse-bashism",
    says: "bash process substitution <( )",
    wrongIn: ["powershell", "cmd"],
    re: /<\(/,
    certain: true,
  },
  {
    code: "S009",
    cls: "parse-bashism",
    says: "&> redirect",
    wrongIn: ["powershell", "cmd"],
    re: /&>>?\s*\S/,
    certain: false,
  },
  {
    code: "S010",
    cls: "parse-bashism",
    says: "bash backslash line continuation",
    wrongIn: ["powershell", "cmd"],
    re: /\\\r?\n/,
    certain: false,
  },
  {
    code: "S011",
    cls: "parse-bashism",
    says: "a trailing & (background) or < input redirect",
    wrongIn: ["powershell"],
    re: /(?:^|[^&\d])&\s*$|(?:^|\s)<\s*[\w."'$]/m,
    certain: true,
  },
  {
    code: "S012",
    cls: "parse-bashism",
    says: "$NAME: inside a string (PowerShell reads a drive-qualified variable)",
    wrongIn: ["powershell"],
    test: (_b, raw) =>
      /\$(?!env:|global:|script:|local:|private:|using:|\{)[A-Za-z_]\w*:(?![:\s"'])/.test(
        raw,
      ),
    certain: true,
  },
  {
    code: "S020",
    cls: "env-form",
    says: "$NAME environment variable",
    wrongIn: ["powershell", "pwsh"],
    test: (b) =>
      [...b.matchAll(/\$\{?([A-Z][A-Z0-9_]+)\}?/g)].some(
        (m) => !PS_AUTOMATIC.has(m[1]),
      ),
    certain: false,
  },
  {
    code: "S021",
    cls: "env-form",
    says: "%NAME% environment variable",
    wrongIn: ["powershell", "pwsh", "bash", "wsl"],
    re: /%[A-Za-z_][A-Za-z0-9_]*%/,
    certain: false,
  },
  {
    code: "S022",
    cls: "env-form",
    says: "$NAME environment variable",
    wrongIn: ["cmd"],
    re: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/,
    certain: false,
  },
  {
    code: "S023",
    cls: "env-form",
    says: "$env:NAME",
    wrongIn: ["bash", "wsl", "cmd"],
    re: /\$env:[A-Za-z_]/i,
    certain: false,
  },
  {
    code: "S030",
    cls: "path-form",
    says: "/dev/null",
    wrongIn: ["powershell", "pwsh", "cmd"],
    re: /\/dev\/(?:null|stdin|stdout|stderr)\b/,
    certain: false,
  },
  {
    code: "S031",
    cls: "path-form",
    says: "a /c/ or /mnt/c/ drive path",
    wrongIn: ["powershell", "pwsh", "cmd"],
    re: /(?:^|[\s"'=(])\/(?:mnt\/)?[a-zA-Z]\/[\w.$-]/,
    certain: false,
  },
  {
    code: "S032",
    cls: "path-form",
    says: "a Unix system path (/tmp, /usr, /home, /etc, /var)",
    wrongIn: ["powershell", "pwsh", "cmd"],
    re: /(?:^|[\s"'=(])\/(?:tmp|usr|home|etc|var|opt|bin|root)(?:\/|\s|$)/,
    certain: false,
  },
  {
    code: "S033",
    cls: "path-form",
    says: "a Windows drive path C:\\",
    wrongIn: ["bash", "wsl"],
    re: /(?:^|[\s=(])[A-Za-z]:\\[\w$.-]/,
    certain: false,
  },
  {
    code: "S034",
    cls: "path-form",
    says: "a path with backslash separators",
    wrongIn: ["bash", "wsl"],
    re: /\b[\w.-]+\\[\w.-]+\\[\w.-]+/,
    certain: false,
  },
  {
    code: "S040",
    cls: "alias-flags",
    says: "ls with Unix flags",
    wrongIn: ["powershell", "pwsh"],
    re: new RegExp(`${CMD_START}ls\\s+-[a-zA-Z]+`),
    certain: false,
  },
  {
    code: "S041",
    cls: "alias-flags",
    says: "rm -rf (rm -r alone works in 5.1)",
    wrongIn: ["powershell", "pwsh"],
    re: new RegExp(`${CMD_START}rm\\s+-(?:[rR]f|f[rR]|[rR][rRf]+)\\b`),
    certain: false,
  },
  {
    code: "S042",
    cls: "alias-flags",
    says: "curl with Unix flags (alias of Invoke-WebRequest in 5.1)",
    wrongIn: ["powershell"],
    re: new RegExp(`${CMD_START}curl\\s+(?:-[a-zA-Z]+|--[a-z-]+)`),
    certain: false,
  },
  {
    code: "S043",
    cls: "alias-flags",
    says: "mv -f, cat -n, sort -x, echo -e, kill -9, ps aux (measured to fail in 5.1; mkdir -p and cp -r work)",
    wrongIn: ["powershell", "pwsh"],
    re: new RegExp(
      `${CMD_START}(?:mkdir\\s+-p|cp\\s+-[rRaf]+|mv\\s+-[fin]+|cat\\s+-[nbAE]+|sort\\s+-[a-zA-Z]+|echo\\s+-[neE]\\b|kill\\s+-\\d+|ps\\s+-?aux)\\b`,
    ),
    certain: false,
  },
  {
    code: "S044",
    cls: "alias-flags",
    says: "find with a Unix expression (Windows find.exe is a text filter)",
    wrongIn: ["powershell", "pwsh", "cmd"],
    re: new RegExp(
      `${CMD_START}find\\s+\\S+\\s+-(?:name|type|iname|maxdepth|exec|mtime)\\b`,
    ),
    certain: false,
  },
  {
    code: "S050",
    cls: "tool-missing",
    says: "a Unix tool the shell may not have",
    wrongIn: ["powershell", "pwsh", "cmd"],
    re: UNIX_TOOL_RE,
    certain: false,
  },
  {
    code: "S060",
    cls: "foreign-syntax",
    says: "a PowerShell cmdlet (Verb-Noun)",
    wrongIn: ["bash", "wsl", "cmd"],
    re: /\b(?:Get|Set|New|Remove|Write|Select|Where|ForEach|Out|Copy|Move|Test|Invoke|Add|Start|Stop|Join|Split|Import|Export|ConvertTo|ConvertFrom|Measure|Sort|Format)-[A-Z][A-Za-z]+/,
    certain: false,
  },
  {
    code: "S061",
    cls: "foreign-syntax",
    says: "a PowerShell variable ($_, $true, $null)",
    wrongIn: ["bash", "wsl", "cmd"],
    re: /\$_(?![A-Za-z0-9_])|\$(?:true|false|null)\b/,
    certain: false,
  },
  {
    code: "S062",
    cls: "foreign-syntax",
    says: "a PowerShell comparison operator",
    wrongIn: ["bash", "wsl", "cmd"],
    re: /\s-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|and|or)\s/,
    certain: false,
    notInBashTest: true,
  },
  {
    code: "S063",
    cls: "foreign-syntax",
    says: "a cmd built-in with /switches (dir /b, del /q, if exist)",
    wrongIn: ["bash", "wsl", "powershell", "pwsh"],
    re: new RegExp(
      `${CMD_START}(?:dir\\s+/[a-zA-Z]|del\\s+/[a-zA-Z]|rmdir\\s+/[a-zA-Z]|if\\s+exist\\b|copy\\s+/[a-zA-Z]|xcopy\\b|findstr\\b)`,
      "i",
    ),
    certain: false,
  },
  {
    code: "S064",
    cls: "foreign-syntax",
    says: "a PowerShell backtick line continuation",
    wrongIn: ["bash", "wsl"],
    re: /`\r?\n/,
    certain: false,
  },
  {
    code: "S065",
    cls: "foreign-syntax",
    says: "a powershell.exe or cmd /c wrapper inside bash",
    wrongIn: ["bash", "wsl"],
    re: new RegExp(
      `${CMD_START}(?:powershell(?:\\.exe)?|pwsh|cmd(?:\\.exe)?\\s+/[cC])\\b`,
    ),
    certain: false,
  },
];

/** What in `command` is written for a shell other than `shell`. */
export function dialectSignals(command, shell) {
  const raw = typeof command === "string" ? command : "";
  const blanked = blankQuoted(raw);
  const found = [];
  for (const s of SIGNALS) {
    if (!s.wrongIn.includes(shell)) continue;
    let hit;
    if (s.test) hit = s.test(blanked, raw);
    else {
      // bash tests ([ a -eq b ]) use the same operators as PowerShell
      const text = s.notInBashTest
        ? blanked.replace(/\[\[?\s[^\]]*\]\]?/g, " ")
        : blanked;
      hit = s.re.test(text);
    }
    if (hit)
      found.push({
        code: s.code,
        cls: s.cls,
        says: s.says,
        certain: s.certain,
      });
  }
  return found;
}

/** The dialect a command reads as: "posix", "powershell", "mixed" or "neutral". */
export function dialectFamily(command) {
  const asPs = dialectSignals(command, "bash").length;
  const asPosix = dialectSignals(command, "powershell").filter(
    (f) => f.cls !== "tool-missing",
  ).length;
  if (asPs > 0 && asPosix === 0) return "powershell";
  if (asPosix > 0 && asPs === 0) return "posix";
  if (asPosix > 0 && asPs > 0) return "mixed";
  return "neutral";
}

const OUTPUT_PATTERNS = [
  {
    cls: "parse-bashism",
    re: /ParserError|ParseException|UnexpectedToken|is not a valid statement separator|Missing expression after|The '<' operator is reserved|syntax error near unexpected token/i,
  },
  {
    cls: "quoting",
    re: /missing the terminator|unterminated|unexpected EOF while looking for matching|Missing closing '\)'|TerminatorExpectedAtEndOfString/i,
  },
  {
    cls: "alias-flags",
    re: /A parameter cannot be found that matches parameter name|Cannot bind parameter|AmbiguousParameter|Parameter set cannot be resolved|Missing an argument for parameter|missing mandatory parameters|Parameter cannot be processed because the parameter name|Cannot find a process with the name/i,
  },
  {
    cls: "tool-missing",
    re: /is not recognized as the name of a cmdlet|CommandNotFoundException|command not found|is not recognized as an internal or external command/i,
  },
  {
    cls: "path-form",
    re: /Cannot find (?:a )?drive|DriveNotFound|DirectoryNotFoundException|The system cannot find the (?:path|file) specified|No such file or directory|Cannot find path|Could not find a part of the path/i,
  },
];

/**
 * Classify one command's outcome. `res` fields: exitCode, stdout, stderr,
 * timedOut. Returns { failed, cls, evidence, signals, silent }:
 *   - a timeout is `hang`;
 *   - a nonzero exit (or PowerShell error records with exit 0) is a failure;
 *     the output patterns name the class, and when they only say "not found"
 *     or "cannot find path" the text's own dialect signals decide, because
 *     those messages are the same for a missing tool and a foreign path;
 *   - an exit 0 command with a certain signal is not a failure but is flagged
 *     `silent`: it ran and did something other than what the text says.
 */
export function classifyOutcome({
  command,
  shell,
  exitCode,
  stdout = "",
  stderr = "",
  timedOut = false,
}) {
  const signals = dialectSignals(command, shell);
  if (timedOut)
    return { failed: true, cls: "hang", evidence: "timeout", signals };
  const err = `${stderr}\n${stdout}`;
  const psErrors =
    PS.has(shell) &&
    /(?:^|\n)\s*(?:\+ CategoryInfo|At line:\d+|[A-Za-z]+Exception:)/.test(err);
  if (exitCode === 0 && !psErrors)
    return {
      failed: false,
      cls: "ok",
      evidence: "",
      signals,
      silent: signals.some((s) => s.certain),
    };
  let cls;
  let evidence = "";
  for (const p of OUTPUT_PATTERNS) {
    if (p.re.test(err)) {
      cls = p.cls;
      evidence = `output matches ${p.cls}`;
      break;
    }
  }
  // The output names the class. Only when it says nothing do the text's own
  // CERTAIN signals decide: a missing tool, a foreign path and a failing
  // program print the same words, and a tool that is installed (Git for
  // Windows puts grep and sed on PATH) can fail for its own reasons.
  if (
    cls === "tool-missing" &&
    signals.some((s) => s.cls === "foreign-syntax")
  ) {
    cls = "foreign-syntax";
    evidence = "not found, and the text is written for another shell";
  }
  const certain = signals.find((s) => s.certain);
  if (!cls && certain) {
    cls = certain.cls;
    evidence = `text signal ${certain.code}: ${certain.says}`;
  }
  if (!cls) {
    cls = "other";
    evidence = `exit ${exitCode}`;
  }
  return { failed: true, cls, evidence, signals };
}

/**
 * A "shell-translation retry": the previous command failed with a dialect
 * class, and this one differs and no longer carries that class's signals
 * (it was rewritten for the host). Pure on the two steps.
 */
export function isTranslationRetry(prev, next, shell) {
  if (!prev || !next || !prev.failed || !DIALECT_CLASSES.has(prev.cls))
    return false;
  if (next.command === prev.command) return false;
  return (
    dialectSignals(next.command, shell).filter((s) => s.cls === prev.cls)
      .length === 0
  );
}

/**
 * Hint loop: the commands of a run alternate between dialect families after
 * a failure (posix, powershell, posix). Returns the number of family flips
 * between consecutive non-neutral commands; 2 or more is oscillation.
 */
export function familyFlips(commands) {
  let flips = 0;
  let last = null;
  for (const c of commands) {
    const f = dialectFamily(c);
    if (f === "neutral" || f === "mixed") continue;
    if (last && f !== last) flips++;
    last = f;
  }
  return flips;
}

/** A command repeated unchanged after a failure: wasted turns. */
export function repeatedFailures(steps) {
  let n = 0;
  for (let i = 1; i < steps.length; i++) {
    if (steps[i - 1].failed && steps[i].command === steps[i - 1].command) n++;
  }
  return n;
}

/** Bytes of a written file: byte order mark, line endings, NULs (UTF-16 text). */
export function inspectBytes(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let bom = null;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom = "utf8";
  else if (b[0] === 0xff && b[1] === 0xfe) bom = "utf16le";
  else if (b[0] === 0xfe && b[1] === 0xff) bom = "utf16be";
  const text = b.toString("latin1");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return {
    bom,
    crlf,
    lf,
    hasNul: b.includes(0),
    crlfOnly: crlf > 0 && lf === 0,
    mixed: crlf > 0 && lf > 0,
  };
}

/** The encoding failure for a file: "utf16", "bom", "crlf", or null when clean. */
export function encodingProblem(buf) {
  const i = inspectBytes(buf);
  if (i.bom === "utf16le" || i.bom === "utf16be" || i.hasNul) return "utf16";
  if (i.bom === "utf8") return "bom";
  if (i.crlf > 0) return "crlf";
  return null;
}
