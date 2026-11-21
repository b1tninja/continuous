/**
 * Commands that print or send credentials without naming a secret file, and
 * paths that can leak the user's Windows credentials. Both make a call ask.
 * Words are matched exactly as written, so this works on the candidates from
 * `commandCandidates` as well as on a plain path.
 */

/**
 * Does a variable name look like it holds a credential? Whole words only,
 * split on `_`/`-`: AWS_SECRET_ACCESS_KEY and GITHUB_TOKEN match, KEYBOARD_LAYOUT
 * and MONKEY do not. Common fused forms (APIKEY, ACCESSKEY) are listed.
 */
const SECRET_WORD =
  /^(keys?|secrets?|tokens?|passw(or)?ds?|pwd|credentials?|creds?|cookies?|(api|access|private|secret|auth|signing|encryption)keys?|apitokens?|authtokens?|accesstokens?|bearer|sessions?|jwt|dsn)$/i;

export function looksSecret(name: string): boolean {
  return name.split(/[_-]/).some((w) => SECRET_WORD.test(w));
}

/**
 * The one variable every shell sets to something that is not a credential:
 * `PWD`, the current directory. The word list reads it as an abbreviation of
 * "password". Only that exact name is skipped, in any letter case (PowerShell
 * ignores case, and the command candidates fold it): `DB_PWD`, `MYSQL_PWD`
 * and `PWD_FILE` still match. A variable the person names `pwd` in bash is
 * the cost of that, and an ask is the safe side of it.
 */
export function isCurrentDirectoryVariable(name: string): boolean {
  return name.toLowerCase() === "pwd";
}

/** `$NAME`, `${NAME}`, `%NAME%`, `$env:NAME`: the variable names a word mentions. */
export function variableNames(word: string): string[] {
  const names: string[] = [];
  const patterns = [
    /\$\{?env:([A-Za-z_]\w*)\}?/gi,
    /\$\{([A-Za-z_]\w*)[^}]*\}/g,
    /\$([A-Za-z_]\w*)/g,
    /%([A-Za-z_]\w*)%/g,
  ];
  for (const re of patterns) {
    for (let m = re.exec(word); m; m = re.exec(word)) names.push(m[1]);
  }
  return names;
}

/** A PowerShell environment drive: `env:`, `env:\`, `env:PATH`, `Env:\AWS_KEY`. */
const PS_ENV_DRIVE = /^env:(\\|\/|$|[A-Za-z_])/i;

/** `env`, `printenv`, `set`, `export`, `declare`, `compgen -v` that list the environment. */
const DUMP_COMMANDS = new Set([
  "env",
  "printenv",
  "set",
  "export",
  "declare",
  "typeset",
]);

/** Commands that print one variable when given its bare name. */
const PRINT_VARIABLE = new Set(["printenv", "echo", "printf", "write-output"]);

/**
 * A short label for what makes this word sensitive, or undefined.
 * `isFirstWord` is true for the command name, which matters for bare `env`.
 * `previous` is the command name when this word is its argument, so
 * `printenv AWS_SECRET_ACCESS_KEY` (a bare variable name) is seen too.
 */
export function secretWordLabel(
  word: string,
  isFirstWord: boolean,
  hasArgs: boolean,
  previous?: string,
): string | undefined {
  const name = word.toLowerCase();
  if (isFirstWord && DUMP_COMMANDS.has(name) && !hasArgs) {
    return "the environment variables";
  }
  if (PS_ENV_DRIVE.test(word)) {
    return "the environment variables (env:)";
  }
  if (previous && PRINT_VARIABLE.has(previous.toLowerCase())) {
    if (
      /^[A-Za-z_]\w*$/.test(word) &&
      !isCurrentDirectoryVariable(word) &&
      looksSecret(word)
    ) {
      return `the variable ${word}`;
    }
  }
  for (const v of variableNames(word)) {
    if (isCurrentDirectoryVariable(v)) continue;
    if (looksSecret(v)) return `the variable ${v}`;
  }
  return undefined;
}

/**
 * jq's `env` and `$ENV` print the process environment. A field named `.env`
 * does not: the builtin is an identifier, not a lookup that starts with a dot.
 */
export function jqEnvironmentLabel(words: string[]): string | undefined {
  const at = words.findIndex((w) => /(^|\/)jq$/i.test(w));
  if (at < 0) return undefined;
  const program = words.slice(at + 1).join(" ");
  if (/\$ENV\b/.test(program) || /(^|[^.\w$])env\b/.test(program)) {
    return "the environment variables (jq)";
  }
  return undefined;
}

/** The program a word names, without its folder or a Windows extension. */
function programOf(word: string): string {
  const base = word.replace(/^.*[\\/]/, "").toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/** The words after `program` that are not options, lowercased, in order. */
function subcommands(args: string[]): string[] {
  return args.filter((w) => !w.startsWith("-")).map((w) => w.toLowerCase());
}

const has = (args: string[], ...names: string[]) =>
  args.some((a) => names.includes(a.toLowerCase()));

/**
 * True when `want` appears among the non-option words in that order, with
 * anything between. An option can take a value (`gh --hostname github.com auth
 * token`), and which options do is a fact about each program that this check
 * does not carry, so the value must not hide the subcommand. The cost: a word
 * that merely sits between them also matches, which only makes it ask.
 */
function runs(sub: string[], ...want: string[]): boolean {
  let at = 0;
  for (const w of sub) {
    if (w === want[at]) at++;
    if (at === want.length) return true;
  }
  return false;
}

/**
 * What a command prints when it is a credential helper: the token a login
 * tool holds, a cloud key read back, a keychain entry. Each rule names the one
 * subcommand that prints a secret; `gh auth status`, `aws configure get
 * region` and `kubectl config view` print none and stay quiet. A command is
 * found by its program name anywhere in the words, so `env X=1 gh auth token`
 * and `C:\\Program Files\\GitHub CLI\\gh.exe auth token` are seen too.
 */
export function credentialCommandLabel(words: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const program = programOf(words[i]);
    const args = words.slice(i + 1);
    const sub = subcommands(args);
    let what: string | undefined;
    switch (program) {
      case "gh":
        if (runs(sub, "auth", "token")) what = "auth token";
        else if (
          runs(sub, "auth", "status") &&
          has(args, "-t", "--show-token")
        ) {
          what = "auth status --show-token";
        }
        break;
      case "aws":
        const secretKey = sub.find((w) =>
          /^(aws_)?(secret_access_key|session_token)$/.test(w),
        );
        if (runs(sub, "configure", "get") && secretKey) {
          what = `configure get ${secretKey}`;
        } else if (runs(sub, "configure", "export-credentials")) {
          what = "configure export-credentials";
        } else if (runs(sub, "ecr", "get-login-password")) {
          what = "ecr get-login-password";
        }
        break;
      case "gcloud":
        if (has(args, "print-access-token", "print-identity-token")) {
          what = "auth print-access-token";
        }
        break;
      case "az":
        if (runs(sub, "account", "get-access-token")) {
          what = "account get-access-token";
        }
        break;
      case "kubectl":
        if (runs(sub, "config", "view") && has(args, "--raw")) {
          what = "config view --raw";
        }
        break;
      case "security":
        if (
          has(
            args,
            "find-generic-password",
            "find-internet-password",
            "dump-keychain",
          )
        ) {
          what = sub.find((w) =>
            [
              "find-generic-password",
              "find-internet-password",
              "dump-keychain",
            ].includes(w),
          );
        }
        break;
      case "git":
        if (runs(sub, "credential", "fill")) {
          what = "credential fill";
        }
        break;
      case "pass":
        if (runs(sub, "show")) what = "show";
        break;
      case "op":
        if (runs(sub, "read")) what = "read";
        break;
      case "convertfrom-securestring":
        if (has(args, "-asplaintext")) what = "-AsPlainText";
        break;
    }
    if (what) {
      return `the output of ${program === "convertfrom-securestring" ? "ConvertFrom-SecureString" : program} ${what}`;
    }
  }
  return undefined;
}

/**
 * A network path: `\\host\share` or `//host/share` (UNC) and the `/net/`
 * automount. Looking one up contacts the host, and on Windows that can send
 * the user's credentials to it. Check the raw text: normalising a path
 * collapses the leading double slash.
 */
export function isNetworkPath(raw: string): boolean {
  const p = raw.trim().replace(/^['"]+|['"]+$/g, "");
  return /^(\\\\|\/\/)[^\\/]+[\\/]/.test(p) || /^\/net\/[^/]+/.test(p);
}
