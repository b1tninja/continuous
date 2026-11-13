/**
 * Which interpreter reads a command. The shell a command is handed to is only
 * the first reader: `bash -c '...'`, `cmd /c ...`, `wsl ...`, `ssh host ...`,
 * `python -c ...` and `./deploy.sh` each hand text to another one, with its own
 * quoting, separators and expansion. This module names that interpreter from
 * the command line alone, says how it was determined and how sure that is, and
 * returns the text the inner interpreter is given when the command line holds
 * it (plans/research/shell-awareness.md).
 *
 * Pure: no file is read and no program is asked. A caller that may read the
 * workspace passes `readFirstLine` so a script's first line (`#!`) can name
 * its interpreter.
 *
 * It is a description, not a verdict. The deny and ask rules already read
 * inside these forms (candidates.ts); nothing here loosens them.
 */
import type { ShellKind } from "../../util/shell";
import { parseCommand } from "./command";
import { commandName, dequote, splitRawWords } from "./shellWords";
import { skipWrapperFlags } from "./wrapperWords";

export type InterpreterFamily =
  | "bash"
  | "zsh"
  | "sh"
  | "fish"
  | "powershell"
  | "cmd"
  | "python"
  | "node"
  | "perl"
  | "ruby"
  | "php"
  /** Windows Script Host: what `.js`, `.vbs` and `.wsf` mean to cmd and PowerShell */
  | "wsh"
  /** A known program that is not a shell and runs no script of its own */
  | "program"
  | "unknown";

/** How the interpreter was determined. */
export type InterpreterVia =
  /** Nothing in the command changes it: the shell the command is handed to */
  | "outer"
  /** A launcher on the command line names it (`bash -c`, `cmd /c`, `python -c`) */
  | "wrapper"
  /** A script file's name or extension suggests it; the file was not read */
  | "script"
  /** The script's first line was read and names it */
  | "shebang"
  /** It cannot be told from the command line */
  | "unknown";

export type InterpreterConfidence = "high" | "medium" | "low";

export interface CommandInterpreter {
  family: InterpreterFamily;
  via: InterpreterVia;
  confidence: InterpreterConfidence;
  /** Short words for a person: "bash -c", "cmd /c", "the remote shell (ssh)". */
  label: string;
  /** The launchers peeled to get here, outermost first: ["env", "wsl", "bash -c"]. */
  chain: string[];
  /** The text the interpreter is given, when the command line holds it. */
  inner?: string;
  /** The file whose content is what runs, when it is a script. */
  script?: string;
  /** Where it runs when that is not this machine's own session. */
  elsewhere?: "wsl" | "remote" | "container";
  /**
   * What runs is not written in the command line: a script file, standard
   * input, a variable, text that could not be decoded.
   */
  opaque: boolean;
  /** Another interpreter than the outer shell reads the command (or part of it). */
  changes: boolean;
  /**
   * The command line already says this in so many words (`python manage.py`,
   * `npm test`, `bash deploy.sh`, `make`): true, and not worth a line of its
   * own on an approval card.
   */
  evident?: boolean;
  /** Why it is less than certain, for the card and the audit record. */
  note?: string;
}

export interface InterpreterOptions {
  /** The platform the command runs on; decides what a file extension means. */
  platform?: NodeJS.Platform;
  /**
   * The first line of a file, or undefined when it cannot or must not be read
   * (outside the workspace, too large, missing). Never called for a path with
   * a variable, a glob or a home shortcut in it.
   */
  readFirstLine?: (path: string) => string | undefined;
}

/** Wrappers that run the words after them as a program, in the same place. */
const PREFIX_WRAPPERS = new Set(
  "env sudo doas nohup nice ionice timeout time stdbuf setsid command exec builtin chronic caffeinate unbuffer busybox winpty".split(
    " ",
  ),
);

const POSIX_SHELL_FAMILY: Record<string, InterpreterFamily> = {
  bash: "bash",
  rbash: "bash",
  zsh: "zsh",
  sh: "sh",
  dash: "sh",
  ash: "sh",
  ksh: "unknown",
  mksh: "unknown",
  fish: "fish",
  tcsh: "unknown",
  csh: "unknown",
  nu: "unknown",
  xonsh: "unknown",
  elvish: "unknown",
};

const LANGUAGE_FAMILY: [RegExp, InterpreterFamily][] = [
  [/^(python[\d.]*|py|pypy[\d.]*)$/, "python"],
  [/^(node|nodejs|deno|bun|tsx|ts-node)$/, "node"],
  [/^perl[\d.]*$/, "perl"],
  [/^ruby[\d.]*$/, "ruby"],
  [/^php[\d.]*$/, "php"],
];

/** Flags that hand a language interpreter its program as text. */
const INLINE_CODE_FLAGS = new Set("-c -e -p -r --eval --print".split(" "));

const SSH_VALUE_FLAGS = new Set(
  "-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -Q -R -S -W -w".split(
    " ",
  ),
);

const WSL_VALUE_FLAGS = new Set(
  "-d --distribution -u --user --cd --shell-type --system".split(" "),
);

/** `wsl --list`, `--shutdown` and the like manage WSL and run no command in it. */
const WSL_MANAGEMENT =
  /^(-l|--list|--shutdown|--status|--update|--install|--export|--import|--unregister|--terminate|-t|--set-default|-s|--set-version|--set-default-version|--version|-v|--help|--mount|--unmount|--manage)$/;

const CONTAINER_EXEC_VALUE_FLAGS = new Set(
  "-e --env --env-file -u --user -w --workdir --detach-keys -c --container -n --namespace".split(
    " ",
  ),
);

const CONTAINER_RUN_VALUE_FLAGS = new Set(
  "-e --env --env-file -v --volume -p --publish -w --workdir -u --user --name --network --net --entrypoint -m --memory --mount -l --label -h --hostname --cpus --platform --pull --add-host --cap-add --cap-drop --security-opt --ip --gpus --restart --tmpfs --ulimit --shm-size --pid --ipc --userns --runtime --device --dns --log-driver --log-opt --stop-signal --cidfile --annotation".split(
    " ",
  ),
);

/** What a file extension means when the file is named as a command. */
const WINDOWS_SCRIPT_FAMILY: Record<string, InterpreterFamily> = {
  ".cmd": "cmd",
  ".bat": "cmd",
  ".ps1": "powershell",
  ".vbs": "wsh",
  ".vbe": "wsh",
  ".js": "wsh",
  ".jse": "wsh",
  ".wsf": "wsh",
  ".wsh": "wsh",
  ".py": "python",
  ".pyw": "python",
};

const EXTENSION_HINT: Record<string, InterpreterFamily> = {
  ".sh": "sh",
  ".bash": "bash",
  ".zsh": "zsh",
  ".fish": "fish",
  ".ps1": "powershell",
  ".py": "python",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".ts": "node",
  ".pl": "perl",
  ".rb": "ruby",
  ".php": "php",
};

const MAX_PEEL = 8;

/** Quote removal for a PowerShell or cmd word: the quotes go, a backslash stays. */
function unquoteWindowsWord(raw: string): string {
  const m = /^(["'])([\s\S]*)\1$/.exec(raw);
  return m ? m[2] : raw;
}

function outerFamily(outer: ShellKind | undefined): InterpreterFamily {
  return outer && outer !== "unknown" ? outer : "unknown";
}

function isPosixOuter(outer: ShellKind | undefined): boolean {
  return outer === "bash" || outer === "zsh" || outer === "sh";
}

function extensionOf(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** A word that names a file by path: `./x`, `/opt/x`, `..\x`, `C:\x`, `~/x`. */
function looksLikePath(word: string): boolean {
  return /^(\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(word);
}

/** A path that can be read as written: no variable, substitution, glob or `~`. */
function isLiteralPath(word: string): boolean {
  return !/[$`*?[\]{}~%]/.test(word);
}

/**
 * The interpreter a first line names: `#!/bin/sh`, `#!/usr/bin/env python3`,
 * `#!/usr/bin/env -S deno run`. Undefined when the line is not a `#!` line.
 */
export function shebangInterpreter(
  firstLine: string | undefined,
): { family: InterpreterFamily; program: string } | undefined {
  const line = (firstLine ?? "").replace(/^\uFEFF/, "").trimEnd();
  if (!line.startsWith("#!")) return undefined;
  const words = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  let i = 0;
  if (commandName(words[0]) === "env") {
    i = 1;
    // `env -S prog args`, `env -i`, `env VAR=1 prog`
    while (
      i < words.length &&
      (words[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(words[i]))
    ) {
      i++;
    }
  }
  const program = commandName(words[i] ?? "");
  if (!program) return undefined;
  return { family: familyOfProgram(program), program };
}

function familyOfProgram(name: string): InterpreterFamily {
  if (Object.hasOwn(POSIX_SHELL_FAMILY, name)) return POSIX_SHELL_FAMILY[name];
  if (name === "powershell" || name === "pwsh") return "powershell";
  if (name === "cmd") return "cmd";
  if (name === "cscript" || name === "wscript") return "wsh";
  for (const [re, family] of LANGUAGE_FAMILY) if (re.test(name)) return family;
  return "program";
}

/**
 * A PowerShell parameter may be shortened to any prefix that is not
 * ambiguous, and the host resolves a few short ones itself: `-c` is
 * `-Command`, `-e`, `-ec` and `-enc` are `-EncodedCommand`, `-f` is `-File`,
 * `-ex` and `-ep` are `-ExecutionPolicy`. A leading `/` is accepted for `-`.
 */
function powershellParameter(
  word: string,
): "command" | "encoded" | "file" | "value" | "switch" | undefined {
  const m = /^[-/\u2013\u2014\u2015]([A-Za-z]+)$/.exec(word);
  if (!m) return undefined;
  const n = m[1].toLowerCase();
  if (n === "ex" || n === "ep" || "executionpolicy".startsWith(n)) {
    // `-e` alone is EncodedCommand, not ExecutionPolicy
    if (n !== "e") return "value";
  }
  if (n === "ec" || "encodedcommand".startsWith(n)) return "encoded";
  if ("command".startsWith(n)) return "command";
  if ("file".startsWith(n)) return "file";
  for (const valued of [
    "windowstyle",
    "inputformat",
    "outputformat",
    "workingdirectory",
    "configurationname",
    "custompipename",
    "settingsfile",
    "psconsolefile",
    "version",
    "encodedarguments",
  ]) {
    if (valued.startsWith(n)) return "value";
  }
  if (n === "wd" || n === "ea" || n === "if" || n === "of") return "value";
  return "switch";
}

/** `-EncodedCommand` text: base64 of UTF-16LE. Undefined when it is not that. */
export function decodeEncodedCommand(text: string): string | undefined {
  const b64 = text.trim();
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return undefined;
  }
  // atob, not Buffer: this module is also bundled into the webview
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return undefined;
  }
  if (binary.length === 0 || binary.length % 2 !== 0) return undefined;
  let decoded = "";
  for (let k = 0; k < binary.length; k += 2) {
    decoded += String.fromCharCode(
      binary.charCodeAt(k) | (binary.charCodeAt(k + 1) << 8),
    );
  }
  // Not text: the word was something else that happens to be base64
  if (/[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(decoded)) return undefined;
  return decoded;
}

interface Peel {
  chain: string[];
  elsewhere?: CommandInterpreter["elsewhere"];
  /** A launcher whose own flags could not all be read: less sure of the rest */
  unsure?: string;
}

function result(
  peel: Peel,
  outer: ShellKind | undefined,
  fields: Partial<CommandInterpreter> &
    Pick<CommandInterpreter, "family" | "via" | "label">,
): CommandInterpreter {
  const confidence: InterpreterConfidence = peel.unsure
    ? "low"
    : (fields.confidence ?? "high");
  const chain = fields.chain ?? peel.chain;
  return {
    opaque: false,
    ...fields,
    confidence,
    chain,
    ...(peel.elsewhere ? { elsewhere: peel.elsewhere } : {}),
    note: fields.note ?? peel.unsure,
    changes:
      fields.changes ??
      (fields.via !== "outer" ||
        !!peel.elsewhere ||
        fields.family !== outerFamily(outer)),
  };
}

/** What one step of reading a command works on. */
interface Cursor {
  words: string[];
  raw: string[];
  /** The index of the word being read */
  i: number;
  peel: Peel;
  outer: ShellKind | undefined;
  platform: NodeJS.Platform;
  opts: InterpreterOptions;
}

/**
 * A step either names the interpreter, or peels a launcher and says "next"
 * (the cursor has moved to the program the launcher runs), or is not about
 * this word at all (undefined).
 */
type Step = (
  c: Cursor,
  name: string,
  word: string,
) => CommandInterpreter | "next" | undefined;

/** The answer when nothing more is peeled: the shell at hand, or the other side's. */
function unchanged(c: Cursor): CommandInterpreter {
  const { peel, outer } = c;
  if (peel.elsewhere) {
    return result(peel, outer, {
      family: "unknown",
      via: "unknown",
      confidence: "low",
      label:
        peel.elsewhere === "wsl"
          ? "the default shell of the WSL distribution"
          : peel.elsewhere === "remote"
            ? "the login shell on the remote host"
            : "the program in the container",
      inner: c.words.slice(c.i).join(" "),
      note: "which shell reads this is decided on the other side",
    });
  }
  const known = !!outer && outer !== "unknown";
  return result(peel, outer, {
    family: outerFamily(outer),
    via: known ? "outer" : "unknown",
    confidence: known ? "high" : "low",
    label: known ? outer : "an unknown shell",
    changes: false,
  });
}

/** PowerShell's call and dot-source operators: the next word is what runs. */
const callOperator: Step = (c, _name, word) => {
  if (c.outer !== "powershell" || (word !== "&" && word !== ".")) {
    return undefined;
  }
  const target = c.words[c.i + 1] ?? "";
  if (!target || /^[$(@]/.test(target)) {
    return result(c.peel, c.outer, {
      family: "unknown",
      via: "unknown",
      confidence: "low",
      label: "a program named by a variable",
      opaque: true,
      note: "the program is built when the command runs",
    });
  }
  c.i++;
  return "next";
};

const prefixWrapper: Step = (c, name) => {
  if (!PREFIX_WRAPPERS.has(name)) return undefined;
  c.peel.chain.push(name);
  if (name === "env") {
    // `env -S "FOO=1 prog args"` splits one string into a command
    const split = c.words.findIndex(
      (w, k) => k > c.i && /^(-S|--split-string)/.test(w),
    );
    if (split >= 0) {
      const w = c.words[split];
      const text = w.startsWith("--split-string=")
        ? w.slice(15)
        : w.length > 2 && !w.startsWith("--")
          ? w.slice(2)
          : (c.words[split + 1] ?? "");
      const inner = classifyInterpreter(text, c.outer, c.opts);
      return {
        ...inner,
        chain: [...c.peel.chain, ...inner.chain],
        changes: true,
      };
    }
  }
  c.i = skipWrapperFlags(c.words, c.i + 1, name);
  return "next";
};

/** watch hands its arguments to `sh -c`. */
const watchStep: Step = (c, name) => {
  if (name !== "watch") return undefined;
  c.peel.chain.push("watch");
  let k = c.i + 1;
  while (k < c.words.length && c.words[k].startsWith("-")) {
    k += /^(-n|--interval)$/.test(c.words[k]) ? 2 : 1;
  }
  return result(c.peel, c.outer, {
    family: "sh",
    via: "wrapper",
    label: "sh -c (watch)",
    inner: c.words.slice(k).join(" "),
  });
};

/** eval, source and Invoke-Expression: text or a file read into a shell. */
const evalStep: Step = (c, name, word) => {
  const { peel, outer, words } = c;
  if (name === "eval") {
    peel.chain.push("eval");
    const inner = words.slice(c.i + 1).join(" ");
    const dynamic = /[$`]/.test(inner);
    return result(peel, outer, {
      family: outerFamily(outer),
      via: "wrapper",
      label: "eval",
      inner,
      confidence: dynamic ? "low" : "high",
      opaque: dynamic,
      changes: true,
    });
  }
  if (isPosixOuter(outer) && (name === "source" || word === ".")) {
    return result(peel, outer, {
      family: outerFamily(outer),
      via: "script",
      label: `${word} (a script read into this shell)`,
      script: words[c.i + 1],
      opaque: true,
      confidence: "medium",
      changes: true,
    });
  }
  if (name === "iex" || name === "invoke-expression") {
    const inner = words.slice(c.i + 1).join(" ");
    const dynamic = /[$(]/.test(inner);
    return result(peel, outer, {
      family: "powershell",
      via: "wrapper",
      label: "Invoke-Expression",
      chain: [...peel.chain, "Invoke-Expression"],
      inner,
      confidence: dynamic ? "low" : "high",
      opaque: dynamic,
      changes: true,
    });
  }
  return undefined;
};

/** Start-Process, xargs and `find -exec`: a program started with arguments from elsewhere. */
const starterStep: Step = (c, name) => {
  const { peel, outer, words } = c;
  if (
    name === "start-process" ||
    name === "saps" ||
    (name === "start" && outer === "powershell")
  ) {
    return startProcess(words, c.i, peel, outer);
  }
  if (name === "xargs") {
    peel.chain.push("xargs");
    return result(peel, outer, {
      family: "program",
      via: "wrapper",
      label: "xargs (arguments come from its input)",
      confidence: "low",
      opaque: true,
      note: "the arguments are read from standard input",
    });
  }
  if (name === "find") {
    const k = words.findIndex(
      (w, j) => j > c.i && /^-(exec|execdir|ok|okdir)$/.test(w),
    );
    if (k < 0) return unchanged(c);
    peel.chain.push(`find ${words[k]}`);
    c.i = k + 1;
    return "next";
  }
  return undefined;
};

const wslStep: Step = (c, name) => {
  if (name !== "wsl") return undefined;
  const { peel, outer, words } = c;
  let k = c.i + 1;
  let direct = false;
  while (k < words.length && words[k].startsWith("-")) {
    const flag = words[k];
    if (WSL_MANAGEMENT.test(flag)) return unchanged(c);
    k++;
    if (flag === "--") break;
    if (flag === "-e" || flag === "--exec") {
      direct = true;
      break;
    }
    if (WSL_VALUE_FLAGS.has(flag)) k++;
  }
  peel.chain.push(direct ? "wsl --exec" : "wsl");
  peel.elsewhere = "wsl";
  c.i = k;
  if (c.i < words.length) return "next";
  return result(peel, outer, {
    family: "unknown",
    via: "wrapper",
    confidence: "low",
    label: "an interactive shell in WSL",
    opaque: true,
  });
};

const sshStep: Step = (c, name) => {
  if (name !== "ssh") return undefined;
  const { peel, outer, words } = c;
  let k = c.i + 1;
  while (k < words.length && words[k].startsWith("-")) {
    k += SSH_VALUE_FLAGS.has(words[k]) ? 2 : 1;
  }
  const host = words[k];
  peel.chain.push("ssh");
  peel.elsewhere = "remote";
  const inner = words.slice(k + 1).join(" ");
  return result(peel, outer, {
    family: "unknown",
    via: inner ? "wrapper" : "unknown",
    confidence: "low",
    label: `the login shell on ${host ?? "the remote host"} (ssh)`,
    ...(inner ? { inner } : {}),
    opaque: !inner,
    note: "the remote account's login shell reads the command; it is not known here",
  });
};

/** `docker exec`, `docker run`, their podman and nerdctl twins, and `kubectl exec --`. */
const containerStep: Step = (c, name) => {
  const { peel, outer, words } = c;
  if (name === "kubectl" && words[c.i + 1] === "exec") {
    const k = words.indexOf("--", c.i);
    if (k < 0) return unchanged(c);
    peel.chain.push("kubectl exec");
    peel.elsewhere = "container";
    c.i = k + 1;
    return "next";
  }
  const verb = words[c.i + 1] ?? "";
  if (!/^(docker|podman|nerdctl)$/.test(name) || !/^(exec|run)$/.test(verb)) {
    return undefined;
  }
  const valued =
    verb === "exec" ? CONTAINER_EXEC_VALUE_FLAGS : CONTAINER_RUN_VALUE_FLAGS;
  let k = c.i + 2;
  while (k < words.length && words[k].startsWith("-")) {
    const flag = words[k];
    k++;
    if (flag === "--") break;
    // `--name=x` and grouped short switches (`-it`) carry no separate value
    if (flag.includes("=") || /^-[a-z]{2,}$/.test(flag)) continue;
    if (valued.has(flag)) k++;
    else if (flag.startsWith("--") && verb === "run") {
      // A long flag this table does not know may or may not take a value
      peel.unsure = `${name} run has a flag this reader does not know (${flag})`;
    }
  }
  peel.chain.push(`${name} ${verb}`);
  peel.elsewhere = "container";
  // the container (exec) or the image (run), then the command
  c.i = k + 1;
  if (c.i < words.length) return "next";
  return result(peel, outer, {
    family: "unknown",
    via: "unknown",
    confidence: "low",
    label: "the image's own start command",
    opaque: true,
  });
};

/** A shell named as the program: `bash`, `pwsh`, `cmd`. */
const shellStep: Step = (c, name) => {
  if (Object.hasOwn(POSIX_SHELL_FAMILY, name)) {
    return posixShell(c.words, c.i, name, c.peel, c.outer, c.platform);
  }
  if (name === "powershell" || name === "pwsh") {
    return powershellHost(c.words, c.raw, c.i, name, c.peel, c.outer);
  }
  if (name === "cmd") return cmdHost(c.words, c.raw, c.i, c.peel, c.outer);
  return undefined;
};

/** python, node, perl, ruby, php: code on the command line, or a script file. */
const languageStep: Step = (c, name) => {
  const language = LANGUAGE_FAMILY.find(([re]) => re.test(name))?.[1];
  if (!language) return undefined;
  const { peel, outer, words } = c;
  const k = words.findIndex(
    (w, j) => j > c.i && INLINE_CODE_FLAGS.has(w.toLowerCase()),
  );
  if (k >= 0 && words[k + 1] !== undefined) {
    const label = `${name} ${words[k]}`;
    return result(peel, outer, {
      family: language,
      via: "wrapper",
      label,
      chain: [...peel.chain, label],
      inner: words[k + 1],
    });
  }
  const operand = words.slice(c.i + 1).find((w) => !w.startsWith("-"));
  return result(peel, outer, {
    family: language,
    via: operand ? "script" : "unknown",
    label: operand ? `${name} ${operand}` : `${name} (reads its input)`,
    chain: [...peel.chain, name],
    ...(operand ? { script: operand } : {}),
    opaque: true,
    confidence: "medium",
    evident: !!operand,
  });
};

/** npm scripts and make recipes: the text that runs is in another file. */
const runnerStep: Step = (c, name) => {
  const { peel, outer, words } = c;
  const verb = words[c.i + 1] ?? "";
  if (
    /^(npm|pnpm|yarn|bun)$/.test(name) &&
    /^(run|run-script|test|start|exec|dlx)$/.test(verb)
  ) {
    return result(peel, outer, {
      family: c.platform === "win32" ? "cmd" : "sh",
      via: "script",
      label: `${name} ${verb} (a package script)`,
      chain: [...peel.chain, `${name} ${verb}`],
      script: "package.json",
      opaque: true,
      confidence: "medium",
      evident: true,
      note: "package scripts run in sh, or in cmd.exe on Windows, unless script-shell is set",
    });
  }
  if (name === "make" || name === "gmake" || name === "just") {
    return result(peel, outer, {
      family: "sh",
      via: "script",
      label: `${name} (recipes run in sh)`,
      chain: [...peel.chain, name],
      script: name === "just" ? "justfile" : "Makefile",
      opaque: true,
      confidence: "medium",
      evident: true,
    });
  }
  return undefined;
};

const scriptStep: Step = (c, _name, word) =>
  scriptFile(word, c.peel, c.outer, c.platform, c.opts);

/** In order: the first step that knows the word decides. */
const STEPS: Step[] = [
  callOperator,
  prefixWrapper,
  watchStep,
  evalStep,
  starterStep,
  wslStep,
  sshStep,
  containerStep,
  shellStep,
  languageStep,
  runnerStep,
  scriptStep,
];

/**
 * The interpreter that reads one simple command (no `;`, `&&` or `|` in it;
 * see `interpretersOfCommand` for a whole line), handed to `outer`.
 */
export function classifyInterpreter(
  part: string,
  outer: ShellKind | undefined,
  opts: InterpreterOptions = {},
): CommandInterpreter {
  const raw = splitRawWords(part.trim());
  // A backslash escapes nothing in PowerShell or cmd: a Windows path keeps it
  const words = raw.map(
    outer === "powershell" || outer === "cmd" ? unquoteWindowsWord : dequote,
  );
  const c: Cursor = {
    words,
    raw,
    i: 0,
    peel: { chain: [] },
    outer,
    // A webview has no `process`; what a file extension means is then unknown
    platform:
      opts.platform ??
      (typeof process === "undefined" ? "linux" : process.platform),
    opts,
  };
  for (let peeled = 0; peeled < MAX_PEEL; peeled++) {
    // `A=1 B=2 cmd`: assignments before the program (a POSIX shell, or env)
    while (c.i < words.length && /^[A-Za-z_]\w*=/.test(words[c.i])) c.i++;
    if (c.i >= words.length) return unchanged(c);
    const word = words[c.i];
    const name = commandName(word);
    let moved = false;
    for (const step of STEPS) {
      const answer = step(c, name, word);
      if (answer === undefined) continue;
      if (answer !== "next") return answer;
      moved = true;
      break;
    }
    if (!moved) return unchanged(c);
  }
  return result(c.peel, outer, {
    family: "unknown",
    via: "unknown",
    confidence: "low",
    label: "more nested launchers than are followed",
    opaque: true,
    note: `more than ${MAX_PEEL} launchers in a row`,
  });
}

function posixShell(
  words: string[],
  at: number,
  name: string,
  peel: Peel,
  outer: ShellKind | undefined,
  platform: NodeJS.Platform,
): CommandInterpreter {
  const family = POSIX_SHELL_FAMILY[name];
  // On Windows `bash` is whichever is first on PATH: the WSL launcher in
  // System32, Git's, MSYS2's or Cygwin's. The text cannot say which.
  const pathDependent =
    platform === "win32" && !peel.elsewhere && !isPosixOuter(outer);
  const note = pathDependent
    ? `which ${name} this is depends on PATH (WSL's launcher, Git's or another)`
    : family === "unknown"
      ? `${name} is not a shell this product parses`
      : undefined;
  const confidence: InterpreterConfidence =
    family === "unknown" ? "low" : pathDependent ? "medium" : "high";
  let k = at + 1;
  for (; k < words.length; k++) {
    const w = words[k];
    if (w === "--") {
      k++;
      break;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) {
      const label = `${name} ${w}`;
      return result(peel, outer, {
        family,
        via: "wrapper",
        label,
        chain: [...peel.chain, label],
        inner: words[k + 1] ?? "",
        confidence,
        note,
        changes: true,
      });
    }
    // `-o option`, `--rcfile f`, `--init-file f`, `-O shopt`
    if (/^(-o|\+o|-O|\+O|--rcfile|--init-file)$/.test(w)) k++;
    else if (!/^[-+]/.test(w)) break;
  }
  const operand = words[k];
  return result(peel, outer, {
    family,
    via: operand ? "script" : "unknown",
    label: operand ? `${name} ${operand}` : `${name} (reads its input)`,
    chain: [...peel.chain, name],
    ...(operand ? { script: operand } : {}),
    opaque: true,
    evident: !!operand && family !== "unknown" && !pathDependent,
    confidence: confidence === "high" ? "medium" : confidence,
    note: note ?? "the script's content is not in the command line",
    changes: true,
  });
}

function powershellHost(
  words: string[],
  raw: string[],
  at: number,
  name: string,
  peel: Peel,
  outer: ShellKind | undefined,
): CommandInterpreter {
  const base = { family: "powershell" as const, changes: true };
  for (let k = at + 1; k < words.length; k++) {
    const kind = powershellParameter(words[k]);
    if (kind === "value") {
      k++;
      continue;
    }
    if (kind === "switch") continue;
    const label = `${name} ${kind ? words[k] : ""}`.trim();
    const chain = [...peel.chain, label];
    if (kind === "encoded") {
      const decoded = decodeEncodedCommand(words[k + 1] ?? "");
      return result(peel, outer, {
        ...base,
        via: "wrapper",
        label,
        chain,
        ...(decoded === undefined ? {} : { inner: decoded }),
        opaque: decoded === undefined,
        confidence: decoded === undefined ? "low" : "high",
        note:
          decoded === undefined
            ? "the encoded command could not be decoded"
            : "decoded from base64 (UTF-16LE)",
      });
    }
    if (kind === "file") {
      return result(peel, outer, {
        ...base,
        via: "script",
        label,
        chain,
        script: words[k + 1],
        opaque: true,
        confidence: "medium",
        evident: true,
        note: "the script's content is not in the command line",
      });
    }
    if (kind === "command") {
      const rest = words.slice(k + 1);
      // `-Command -` reads the commands from standard input
      if (rest.length === 1 && rest[0] === "-") {
        return result(peel, outer, {
          ...base,
          via: "unknown",
          label,
          chain,
          opaque: true,
          confidence: "low",
        });
      }
      return result(peel, outer, {
        ...base,
        via: "wrapper",
        label,
        chain,
        // one quoted word is the script; several words are joined by the host
        inner: rest.length === 1 ? rest[0] : raw.slice(k + 1).join(" "),
      });
    }
    // A bare first operand: Windows PowerShell reads it as -Command, pwsh as -File
    const legacy = name === "powershell";
    return result(peel, outer, {
      ...base,
      via: legacy ? "wrapper" : "script",
      label: legacy ? `${name} (as -Command)` : `${name} (as -File)`,
      chain: [...peel.chain, name],
      ...(legacy
        ? { inner: raw.slice(k).join(" ") }
        : { script: words[k], opaque: true }),
      confidence: "medium",
      note: "powershell.exe takes a bare argument as a command, pwsh as a script file",
    });
  }
  return result(peel, outer, {
    ...base,
    via: "unknown",
    label: `${name} (interactive, or reads its input)`,
    chain: [...peel.chain, name],
    opaque: true,
    confidence: "low",
  });
}

function cmdHost(
  words: string[],
  raw: string[],
  at: number,
  peel: Peel,
  outer: ShellKind | undefined,
): CommandInterpreter {
  for (let k = at + 1; k < words.length; k++) {
    const w = words[k];
    // `/c`, `/C`, `/k`, and the attached form `/c"dir"` or `/cdir`
    const m = /^\/([ckr])(.*)$/i.exec(w);
    if (m) {
      const label = `cmd /${m[1].toLowerCase()}`;
      const rest = [m[2], ...raw.slice(k + 1)].filter(Boolean).join(" ");
      return result(peel, outer, {
        family: "cmd",
        via: "wrapper",
        label,
        chain: [...peel.chain, label],
        inner: stripOuterQuotes(rest),
        changes: true,
      });
    }
    if (!w.startsWith("/")) break;
  }
  return result(peel, outer, {
    family: "cmd",
    via: "unknown",
    label: "cmd (interactive, or reads its input)",
    chain: [...peel.chain, "cmd"],
    opaque: true,
    confidence: "low",
    changes: true,
  });
}

/** cmd /c "text": with one outer pair of quotes, cmd takes what is between them. */
function stripOuterQuotes(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"')
    ? t.slice(1, -1)
    : t;
}

function startProcess(
  words: string[],
  at: number,
  peel: Peel,
  outer: ShellKind | undefined,
): CommandInterpreter {
  const rest = words.slice(at + 1);
  const flagIndex = (prefix: string) =>
    rest.findIndex(
      (w) =>
        /^-[A-Za-z]+$/.test(w) && prefix.startsWith(w.slice(1).toLowerCase()),
    );
  const fp = flagIndex("filepath");
  const program = fp >= 0 ? rest[fp + 1] : rest.find((w) => !w.startsWith("-"));
  const al = flagIndex("argumentlist");
  const args = al >= 0 ? rest[al + 1] : undefined;
  const chain = [...peel.chain, "Start-Process"];
  if (!program || /^[$(@]/.test(program)) {
    return result(peel, outer, {
      family: "unknown",
      via: "unknown",
      label: "Start-Process (a program named by a variable)",
      chain,
      opaque: true,
      confidence: "low",
      changes: true,
    });
  }
  const family = familyOfProgram(commandName(program));
  return result(peel, outer, {
    family,
    via: "wrapper",
    label: `Start-Process ${commandName(program)}`,
    chain,
    ...(args !== undefined && !/^[$(@]/.test(args) ? { inner: args } : {}),
    opaque: args === undefined || /^[$(@]/.test(args),
    // -ArgumentList is re-quoted by Start-Process before the program sees it
    confidence: "low",
    note: "Start-Process joins and re-quotes its argument list",
    changes: true,
  });
}

function scriptFile(
  word: string,
  peel: Peel,
  outer: ShellKind | undefined,
  platform: NodeJS.Platform,
  opts: InterpreterOptions,
): CommandInterpreter | undefined {
  const ext = extensionOf(word);
  const windowsShell =
    !peel.elsewhere && (outer === "powershell" || outer === "cmd");
  if (windowsShell) {
    // PATHEXT and the file association decide; a `#!` line means nothing here
    if (!Object.hasOwn(WINDOWS_SCRIPT_FAMILY, ext)) {
      if (!looksLikePath(word) || !Object.hasOwn(EXTENSION_HINT, ext)) {
        return undefined;
      }
      // `.\deploy.sh` from PowerShell or cmd: whatever the extension is
      // associated with opens it (Git Bash, an editor, nothing)
      return result(peel, outer, {
        family: "unknown",
        via: "script",
        label: `${word} (opened by its file association)`,
        script: word,
        opaque: true,
        confidence: "low",
        note: "Windows runs this through the file association for its extension",
      });
    }
    const family = WINDOWS_SCRIPT_FAMILY[ext];
    if (ext === ".ps1" && outer === "cmd") {
      return result(peel, outer, {
        family: "unknown",
        via: "script",
        label: `${word} (opened by its file association, not run)`,
        script: word,
        opaque: true,
        confidence: "low",
        note: "cmd.exe does not run .ps1 files; the association decides what opens",
      });
    }
    return result(peel, outer, {
      family,
      via: "script",
      label:
        family === "wsh"
          ? `${word} (Windows Script Host)`
          : family === "cmd"
            ? `${word} (cmd.exe batch file)`
            : `${word} (${family})`,
      script: word,
      opaque: true,
      confidence: family === "python" ? "low" : "medium",
      note:
        family === "python"
          ? "the file association for this extension decides what runs it"
          : "the script's content is not in the command line",
    });
  }
  // A POSIX shell (or the other side of wsl, ssh, docker): the kernel reads `#!`
  // A bare name is looked up on PATH, not in the folder
  if (!looksLikePath(word)) return undefined;
  const line =
    !peel.elsewhere && isLiteralPath(word)
      ? opts.readFirstLine?.(word)
      : undefined;
  if (line !== undefined) {
    const named = shebangInterpreter(line);
    if (named) {
      return result(peel, outer, {
        family: named.family,
        via: "shebang",
        label: `${word} (#! ${named.program})`,
        script: word,
        opaque: true,
        confidence: "high",
        changes: true,
      });
    }
    // No `#!`: an executable text file is run by the shell itself (as sh)
    return result(peel, outer, {
      family: isPosixOuter(outer) ? outerFamily(outer) : "sh",
      via: "shebang",
      label: `${word} (no #! line: run by the shell)`,
      script: word,
      opaque: true,
      confidence: "medium",
      changes: true,
    });
  }
  if (!ext && !/^\.{1,2}[\\/]/.test(word)) {
    // /usr/bin/git, C:\tools\x: a program by path, as likely a binary as a script
    return undefined;
  }
  const hint = EXTENSION_HINT[ext];
  return result(peel, outer, {
    family: hint ?? "unknown",
    via: "script",
    label:
      outer && outer !== "unknown"
        ? `${word} (its first line names the interpreter)`
        : `${word} (a script: its first line, or on Windows its file type, names the interpreter)`,
    script: word,
    opaque: true,
    confidence: "low",
    note: "the file was not read; its #! line decides, not its name",
    changes: true,
  });
}

export interface InterpreterReading {
  /** 0 for a part of the command itself, 1 for a part of a script it holds, ... */
  depth: number;
  /** The simple command that was classified. */
  part: string;
  interpreter: CommandInterpreter;
}

/** The shell kind to read an inner script with, when it is one this product parses. */
export function shellKindOfFamily(
  family: InterpreterFamily,
): ShellKind | undefined {
  switch (family) {
    case "bash":
    case "zsh":
    case "sh":
    case "powershell":
    case "cmd":
      return family;
    default:
      return undefined;
  }
}

/**
 * Every simple command of `command` and of the scripts nested in it
 * (`bash -c "pwsh -c 'cmd /c dir'"`), each with its interpreter. Nesting is
 * followed `maxDepth` levels; `truncated` says a deeper one was not.
 */
export function interpretersOfCommand(
  command: string,
  outer: ShellKind | undefined,
  opts: InterpreterOptions & { maxDepth?: number } = {},
): { readings: InterpreterReading[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 4;
  const readings: InterpreterReading[] = [];
  let truncated = false;
  const walk = (text: string, shell: ShellKind | undefined, depth: number) => {
    for (const part of parseCommand(text).parts) {
      const interpreter = classifyInterpreter(part, shell, opts);
      readings.push({ depth, part, interpreter });
      if (interpreter.inner === undefined) continue;
      const innerShell = shellKindOfFamily(interpreter.family);
      // A language's code, or an unknown shell's text, is not split as a shell's
      if (!innerShell && interpreter.family !== "unknown") continue;
      if (depth + 1 > maxDepth) {
        truncated = true;
        continue;
      }
      walk(interpreter.inner, innerShell, depth + 1);
    }
  };
  walk(command, outer, 0);
  return { readings, truncated };
}

/**
 * One line for an approval card: the interpreters that are not the outer
 * shell, outermost first, or undefined when the outer shell reads all of it.
 * `uncertain` is true when any of them is opaque, unknown or low-confidence;
 * `hidden` when what one of them runs is not written in the command at all.
 */
export function describeInterpreters(
  command: string,
  outer: ShellKind | undefined,
  opts: InterpreterOptions = {},
): { text: string; uncertain: boolean; hidden: boolean } | undefined {
  const { readings, truncated } = interpretersOfCommand(command, outer, opts);
  const changed = readings.filter(
    (r) => r.interpreter.changes && !r.interpreter.evident,
  );
  if (changed.length === 0 && !truncated) return undefined;
  const labels: string[] = [];
  for (const { interpreter } of changed) {
    const where =
      interpreter.elsewhere === "wsl"
        ? " in WSL"
        : interpreter.elsewhere === "container"
          ? " in a container"
          : "";
    const label = interpreter.label.includes("(ssh)")
      ? interpreter.label
      : `${interpreter.label}${where}`;
    if (!labels.includes(label)) labels.push(label);
  }
  if (truncated) labels.push("more nested commands than are followed");
  return {
    text: labels.join(", then "),
    hidden: truncated || changed.some(({ interpreter: c }) => c.opaque),
    uncertain:
      truncated ||
      changed.some(
        ({ interpreter: c }) =>
          c.opaque || c.family === "unknown" || c.confidence === "low",
      ),
  };
}
