import type { ShellKind } from "../../util/shell";
import { commandCandidateSet } from "./candidates";
import { programName } from "./destinations";
import { infraCommandHit } from "./infraCommands";

/**
 * The built-in rule `ask-destructive-commands` (ROADMAP B14): a command that
 * throws away work or rewrites history asks, at every level below IDGAF, with
 * no model call. It reads the candidate strings the other rules read, word by
 * word, and over-matches on purpose: a flag that could be what makes the
 * command destructive asks.
 *
 *   git reset --hard      git clean -fd        git rebase
 *   git push --force      git branch -D        git checkout -- .
 *   git commit --amend    git branch -m (the current branch, or -M)
 *   rm -rf src            Remove-Item -Recurse   rd /s
 *
 * It cannot see a script that does these inside itself, a program held in a
 * variable (that asks elsewhere: `hidden-command`), or an alias the person
 * defined. `rm -rf` of plain, relative build-output folders (`node_modules`,
 * `dist`) is regenerable and does not ask.
 */

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "exec",
  "command",
  "builtin",
  "nice",
  "xargs",
]);

/** Folders a build recreates. Only a bare relative name counts. */
const REGENERABLE = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  "bin",
  "obj",
]);

const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd"]);
const DESTRUCTIVE_SQL =
  /\b(drop\s+(table|database|schema|index)|truncate\s+table|delete\s+from)\b/i;

const GIT_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** A short-flag bundle such as `-rf` containing one of `letters`. */
function bundleHas(word: string, letters: string): boolean {
  return (
    /^-[A-Za-z]+$/.test(word) && [...letters].some((l) => word.includes(l))
  );
}

const longFlag = (word: string, name: string) =>
  word === `--${name}` || word.startsWith(`--${name}=`);

interface GitCall {
  /** The words after the subcommand */
  rest: string[];
  /** `-f` or `--force` among them */
  force: boolean;
  /** A short flag in a bundle, or the long form */
  flag: (short: string, long: string) => boolean;
}

type GitRule = (call: GitCall) => string | undefined;

const hasWord = (rest: string[], ...words: string[]) =>
  rest.some((w) => words.includes(w));

/** Rules by git subcommand: the text it names when the arguments make it destructive. */
const GIT_RULES: Record<string, GitRule> = {
  commit: ({ rest }) =>
    rest.some((w) => longFlag(w, "amend")) ? "git commit --amend" : undefined,
  reset: ({ rest }) =>
    hasWord(rest, "--hard", "--merge") ? "git reset --hard" : undefined,
  clean: ({ flag }) => (flag("n", "dry-run") ? undefined : "git clean"),
  rebase: ({ rest }) =>
    hasWord(rest, "--abort", "--quit") ? undefined : "git rebase",
  "filter-branch": () => "git filter-branch",
  "filter-repo": () => "git filter-repo",
  push: ({ rest, force }) =>
    force ||
    rest.some(
      (w) =>
        longFlag(w, "force-with-lease") ||
        longFlag(w, "force-if-includes") ||
        longFlag(w, "delete") ||
        longFlag(w, "mirror") ||
        longFlag(w, "prune") ||
        bundleHas(w, "d") ||
        // `+main` forces a ref; `:main` deletes it
        /^\+|^:[^:]/.test(w),
    )
      ? "git push --force"
      : undefined,
  branch: ({ rest, force }) => {
    if (rest.some((w) => bundleHas(w, "D")) || force) return "git branch -D";
    // `-m new` renames the branch that is checked out; `-m old new` another one
    const rename = rest.some((w) => bundleHas(w, "mM") || longFlag(w, "move"));
    const names = rest.filter((w) => !w.startsWith("-"));
    return rename && (names.length < 2 || rest.some((w) => bundleHas(w, "M")))
      ? "git branch -m"
      : undefined;
  },
  tag: ({ flag, force }) =>
    flag("d", "delete") || force ? "git tag -d" : undefined,
  checkout: ({ rest, force }) =>
    force || hasWord(rest, "--", ".")
      ? "git checkout discarding changes"
      : undefined,
  restore: ({ rest }) => {
    const staged = rest.some((w) => longFlag(w, "staged") || w === "-S");
    const worktree = rest.some((w) => longFlag(w, "worktree") || w === "-W");
    return staged && !worktree ? undefined : "git restore";
  },
  switch: ({ rest, force }) =>
    force || rest.some((w) => longFlag(w, "discard-changes"))
      ? "git switch --force"
      : undefined,
  stash: ({ rest }) =>
    rest[0] === "drop" || rest[0] === "clear"
      ? `git stash ${rest[0]}`
      : undefined,
  reflog: ({ rest }) =>
    rest[0] === "expire" || rest[0] === "delete"
      ? `git reflog ${rest[0]}`
      : undefined,
  gc: ({ rest }) =>
    rest.some((w) => longFlag(w, "prune")) ? "git gc --prune" : undefined,
  prune: () => "git prune",
  "update-ref": ({ rest }) =>
    hasWord(rest, "-d") ? "git update-ref -d" : undefined,
  pull: ({ rest }) =>
    rest.some(
      (w) => longFlag(w, "rebase") || w === "-r" || longFlag(w, "force"),
    )
      ? "git pull --rebase"
      : undefined,
  rm: ({ flag, force }) =>
    force || flag("r", "recursive") ? "git rm -rf" : undefined,
  worktree: ({ rest }) =>
    rest[0] === "remove" || rest[0] === "prune"
      ? `git worktree ${rest[0]}`
      : undefined,
};

function gitHit(args: string[]): string | undefined {
  // Skip global options to reach the subcommand
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const rule = Object.hasOwn(GIT_RULES, args[i]?.toLowerCase() ?? "")
    ? GIT_RULES[args[i].toLowerCase()]
    : undefined;
  if (!rule) return undefined;
  const rest = args.slice(i + 1);
  const flag = (short: string, long: string) =>
    rest.some((w) => bundleHas(w, short) || longFlag(w, long));
  return rule({ rest, force: flag("f", "force"), flag });
}

/** True for an operand that is one plain, relative, regenerable folder name. */
function regenerable(operand: string): boolean {
  const name = operand
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  return REGENERABLE.has(name);
}

function rmHit(args: string[]): string | undefined {
  const recursive = args.some(
    (w) => bundleHas(w, "rR") || longFlag(w, "recursive"),
  );
  const operands = args.filter((w) => !w.startsWith("-"));
  const wildcard = operands.some((w) =>
    /^(\.\/)?\*$|^\.$|^\.\/$|^\.\.?\//.test(w),
  );
  if (!recursive && !wildcard) return undefined;
  if (operands.length > 0 && operands.every(regenerable)) return undefined;
  return "rm -r";
}

function powershellRemoveHit(args: string[]): string | undefined {
  return args.some((w) => /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w))
    ? "Remove-Item -Recurse"
    : undefined;
}

function cmdRemoveHit(program: string, args: string[]): string | undefined {
  return args.some((w) => /^\/s$/i.test(w)) ? `${program} /s` : undefined;
}

function hitOfSegment(words: string[]): string | undefined {
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_]\w*=/.test(words[i]) ||
      WRAPPERS.has(programName(words[i]).toLowerCase()))
  ) {
    i++;
  }
  if (i >= words.length) return undefined;
  const program = programName(words[i]).toLowerCase();
  const args = words.slice(i + 1);
  if (program === "git") return gitHit(args);
  if (program === "find") {
    return args.some((w) => w === "-delete") ? "find -delete" : undefined;
  }
  if (["shred", "wipe", "truncate", "dropdb", "dropuser"].includes(program)) {
    return program;
  }
  if (program === "docker" || program === "podman") {
    if (args.includes("prune")) return `${program} prune`;
  }
  const infra = infraCommandHit(program, args);
  if (infra) return infra;
  if (DB_CLIENTS.has(program) && DESTRUCTIVE_SQL.test(args.join(" "))) {
    return `${program} with DROP or TRUNCATE`;
  }
  // `programName` folds rm, rd, rmdir, del and erase into Remove-Item
  const written = (words[i].split(/[\/]/).pop() ?? "").toLowerCase();
  if (["rd", "rmdir", "del", "erase"].includes(written)) {
    const cmd = cmdRemoveHit(written, args);
    if (cmd) return cmd;
  }
  if (program === "remove-item") {
    return rmHit(args) ?? powershellRemoveHit(args);
  }
  return undefined;
}

const SEGMENT_BREAK = /\s*(?:&&|\|\||[|;&\n])\s*/;
const strip = (w: string) => w.replace(/^['"({]+|['")}]+$/g, "");

/** What makes the command destructive, or undefined. Asks on any candidate. */
export function destructiveCommandHit(
  command: string,
  shell?: ShellKind,
): string | undefined {
  for (const candidate of commandCandidateSet(command, shell).list) {
    for (const segment of candidate.split(SEGMENT_BREAK)) {
      const words = segment.trim().split(/\s+/).map(strip).filter(Boolean);
      const hit = words.length ? hitOfSegment(words) : undefined;
      if (hit) return hit;
    }
  }
  return undefined;
}
