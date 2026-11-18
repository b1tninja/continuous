import { isSecretName } from "../../util/secretScan/secretNames";
import { looksSecret } from "./secretCommands";

/**
 * Which environment variable names change what a command does, for the
 * assignment prefix (`NAME=value cmd`, `env NAME=value cmd`, `$env:NAME = ...`,
 * `set NAME=value`). A rule is written about a program and its arguments
 * (`git status`, `npm test`), and the same text means something else when the
 * variable in front of it makes git run another program, makes node load a
 * file, or points a tool at another server. So the name decides.
 *
 *   dangerous  loads code, runs a program, or changes which program a name
 *              means: asks at every level below IDGAF, where it is recorded (like a command whose
 *              name is a variable)
 *   sensitive  redirects configuration, credentials, network or where files
 *              go: asks below IDGAF, like a protected path
 *   harmless   reviewed as inert (colour, locale, log level): never asks
 *   unknown    nothing says it matters: no extra ask. The command is still
 *              never read as read-only (readOnlyCommand.ts), and every rule
 *              still sees the program after the assignments
 *
 * Names are compared ignoring case: Windows variables are not case
 * sensitive, and matching more is the safe direction. The lists are built in.
 * `EnvNameOptions` lets a caller add names (`ask`) or take names off
 * (`allow`); the caller must read them from the person's own config and from
 * nothing else (not a workspace file, an assistant or the environment):
 * `readUserEnvNames` (userEnvNames.ts). An `allow` entry never lowers a name
 * the built-in policy marks dangerous.
 *
 * Sources, one per family. Every page below was re-read on 2026-11-11 (the
 * fetch date is the same for all) and each classified name was checked against
 * it; what a page did not show is said in the line, and such a name keeps the
 * class it had (nothing was loosened by the re-read). Where a page documents
 * a name as inert (for example every `DYLD_PRINT_*` switch), the name still
 * asks because a whole prefix is dangerous and a name moves to harmless only
 * with its own reason and test:
 *   ld.so(8) and the dynamic linker: LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT
 *     https://man7.org/linux/man-pages/man8/ld.so.8.html
 *   dyld(1) on macOS (read as the man page text of the Xcode man pages,
 *     https://keith.github.io/xcode-man-pages/dyld.1.html; Apple's archive
 *     page below was not reachable as text): DYLD_INSERT_LIBRARIES runs code,
 *     the *_PATH, *_SUFFIX and cache variables redirect loading
 *     https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/DynamicLibraries/
 *   Bash manual, "Bash Variables" (5.2) and "Bash Startup Files" (6.2), read at
 *     https://tiswww.case.edu/php/chet/bash/bashref.html (the same text as
 *     https://www.gnu.org/software/bash/manual/bash.html, which refused the
 *     connection): BASH_ENV and ENV are sourced, PROMPT_COMMAND runs; PS4,
 *     SHELLOPTS, BASHOPTS, CDPATH, GLOBIGNORE are read as data and stay
 *     dangerous because they change how the shell reads a command.
 *     BASH_FUNC_* is not in the manual text (exported functions are `export
 *     -f` only), so that prefix rests on bash's own behaviour, not on a page.
 *     HISTFILE, INPUTRC and BASH_XTRACEFD are documented and unlisted here.
 *   POSIX.1-2024 (Issue 8), Environment Variables:
 *     https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap08.html
 *     defines HOME, PATH, TMPDIR, SHELL, LANG, LANGUAGE, LC_*, TZ, COLUMNS,
 *     LINES and NLSPATH. It does NOT define IFS, ENV or LOCPATH: IFS and ENV
 *     are in the shell command language,
 *     https://pubs.opengroup.org/onlinepubs/9799919799/utilities/sh.html
 *     (ENV is expanded and run by interactive shells), and LOCPATH is glibc's.
 *   git(1), "Environment Variables" (git 2.56.0) and git-config(1):
 *     https://git-scm.com/docs/git#_environment_variables
 *     https://git-scm.com/docs/git-config#_environment
 *     Every GIT_* name is classified one by one in gitEnvClasses.ts, checked
 *     against corpus/gitEnvNames.json by gitEnvNames.vitest.ts. GIT_EXEC_PATH
 *     and GIT_CONFIG_PARAMETERS are not in the fetched text.
 *   Node.js CLI: NODE_OPTIONS, NODE_PATH, NODE_EXTRA_CA_CERTS,
 *     NODE_TLS_REJECT_UNAUTHORIZED
 *     https://nodejs.org/api/cli.html#environment-variables
 *   Python CLI (3.15 text): PYTHONPATH, PYTHONSTARTUP, PYTHONHOME,
 *     PYTHONUSERBASE, PYTHONBREAKPOINT, PYTHON_PRESITE run or find code.
 *     PYTHONWARNINGS is NOT inert: a filter category is a class name and the
 *     warnings module imports its module (Lib/warnings.py; the page does not
 *     say so), so it left the harmless list
 *     https://docs.python.org/3/using/cmdline.html#environment-variables
 *   Ruby: RUBYOPT (can hold -r), RUBYLIB (load path); the man page
 *     https://manpages.debian.org/unstable/ruby/ruby.1.en.html (the
 *     docs.ruby-lang.org options page lists RUBYOPT only)
 *   perlrun: PERL5OPT (-M, -d), PERL5LIB, PERLLIB, PERL5DB, PERL5SHELL
 *     https://perldoc.perl.org/perlrun
 *   java launcher: JDK_JAVA_OPTIONS
 *     https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html
 *     JAVA_TOOL_OPTIONS (loads agents), JVM TI specification
 *     https://docs.oracle.com/en/java/javase/21/docs/specs/jvmti.html
 *     _JAVA_OPTIONS is in no primary page and stays dangerous
 *   npm config: any `npm_config_*` is a config option (case-insensitive),
 *     including script-shell, registry, node-options, prefix, git, editor
 *     https://docs.npmjs.com/cli/v10/using-npm/config
 *   pip: `PIP_<UPPER_LONG_NAME>` sets any option, `PIP_CONFIG_FILE` names a
 *     config file
 *     https://pip.pypa.io/en/stable/topics/configuration/
 *   cargo: RUSTC, RUSTC_WRAPPER, RUSTC_WORKSPACE_WRAPPER, RUSTDOC, RUSTFMT,
 *     BROWSER and CARGO_TARGET_<triple>_RUNNER/LINKER run programs; any config
 *     key is `CARGO_<KEY>`. RUST_BACKTRACE and RUST_LOG are not in this page
 *     (they stay harmless on the strength of what they do, not a citation)
 *     https://doc.rust-lang.org/cargo/reference/environment-variables.html
 *   curl(1), ENVIRONMENT: http_proxy (lowercase only), HTTPS_PROXY,
 *     ALL_PROXY, NO_PROXY, CURL_CA_BUNDLE, SSL_CERT_FILE, SSL_CERT_DIR,
 *     CURL_HOME, SSLKEYLOGFILE, QLOGDIR
 *     https://curl.se/docs/manpage.html
 *   OpenSSL openssl-env(7): OPENSSL_CONF, OPENSSL_CONF_INCLUDE,
 *     OPENSSL_MODULES (providers load), SSL_CERT_FILE, SSL_CERT_DIR,
 *     SSLKEYLOGFILE, and `OPENSSL` (the program scripts run)
 *     https://docs.openssl.org/master/man7/openssl-env/
 *   AWS CLI environment variables: AWS_* (credentials, profile, endpoints,
 *     AWS_PAGER runs a program, AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE
 *     name files whose profile can hold `credential_process`)
 *     https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html
 *     https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
 *   Windows: PATHEXT, PSModulePath, PSModuleAnalysisCachePath,
 *     PSExecutionPolicyPreference (about_Environment_Variables), the module
 *     search (about_PSModulePath), COMSPEC and PATH (set command), SystemRoot,
 *     windir, APPDATA, USERPROFILE (USMT recognized variables).
 *     NoDefaultCurrentDirectoryInExePath was not on any page fetched and keeps
 *     its class
 *     https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables
 *     https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath
 *     https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/set_1
 *     https://learn.microsoft.com/en-us/windows/deployment/usmt/usmt-recognized-environment-variables
 */
export type EnvRisk = "dangerous" | "sensitive" | "harmless" | "unknown";

export interface EnvClass {
  risk: EnvRisk;
  /** A few words for the prompt. Never holds a value. */
  why: string;
}

/** What the person's own config says. Nothing else adds to or takes from the lists. */
export interface EnvNameOptions {
  /** Names or `PREFIX*` patterns that always ask */
  ask?: readonly string[];
  /** Names or `PREFIX*` patterns that never ask */
  allow?: readonly string[];
}

/** Inert variables: they change colour, locale, logging and test switches only. */
const HARMLESS = new Set(
  [
    "CI",
    "FORCE_COLOR",
    "NO_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "TERM",
    "COLORTERM",
    "COLUMNS",
    "LINES",
    "LANG",
    "LANGUAGE",
    "TZ",
    "DEBUG",
    "VERBOSE",
    "LOG_LEVEL",
    "LOGLEVEL",
    "NODE_ENV",
    "NODE_NO_WARNINGS",
    "NODE_DISABLE_COLORS",
    "NO_UPDATE_NOTIFIER",
    "DO_NOT_TRACK",
    "NEXT_TELEMETRY_DISABLED",
    "ADBLOCK",
    "DISABLE_OPENCOLLECTIVE",
    "DEBIAN_FRONTEND",
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
    "PYTHONHASHSEED",
    "RUST_BACKTRACE",
    "RUST_LOG",
    "GIT_TERMINAL_PROMPT",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_OPTIONAL_LOCKS",
    "GIT_FLUSH",
    "GIT_CURL_VERBOSE",
    "NPM_CONFIG_LOGLEVEL",
    "NPM_CONFIG_COLOR",
    "NPM_CONFIG_FUND",
    "NPM_CONFIG_AUDIT",
    "NPM_CONFIG_UPDATE_NOTIFIER",
    "NPM_CONFIG_PROGRESS",
  ].map((n) => n.toLowerCase()),
);

/** `LC_ALL`, `LC_CTYPE`, ...: the locale. `LOCPATH` is not one of them. */
const HARMLESS_PREFIXES = ["lc_"];

/** Names that load code, run a program or decide which program a name means. */
const DANGEROUS_EXACT: Record<string, string> = {
  path: "decides which program a command name runs",
  pathext: "decides which file a command name runs",
  comspec: "names the command interpreter",
  psmodulepath: "decides which PowerShell modules load",
  ifs: "changes how the shell splits words",
  env: "a file the shell runs at start",
  bash_env: "a file the shell runs at start",
  shellopts: "changes how the shell runs",
  bashopts: "changes how the shell runs",
  prompt_command: "a command the shell runs",
  ps4: "the shell expands it as a command",
  cdpath: "decides which folder a cd goes to",
  globignore: "changes how the shell expands a name",
  fpath: "decides which functions the shell loads",
  zdotdir: "decides which startup files zsh runs",
  shell: "names the shell that programs start",
  editor: "a program that tools start",
  visual: "a program that tools start",
  pager: "a program that tools start",
  manpager: "a program that tools start",
  lessopen: "a program that less starts",
  browser: "a program that tools start",
  sudo_askpass: "a program that sudo starts",
  ssh_askpass: "a program that ssh starts",
  home: "decides where tools read their config",
  userprofile: "decides where tools read their config",
  homedrive: "decides where tools read their config",
  homepath: "decides where tools read their config",
  appdata: "decides where tools read their config",
  localappdata: "decides where tools read their config",
  xdg_config_home: "decides where tools read their config",
  xdg_config_dirs: "decides where tools read their config",
  xdg_data_home: "decides where tools read their data",
  xdg_data_dirs: "decides where tools read their data",
  systemroot: "decides where Windows programs load from",
  windir: "decides where Windows programs load from",
  nodefaultcurrentdirectoryinexepath:
    "decides if the current folder is searched",
  locpath: "decides which locale files load",
  nlspath: "decides which message files load",
  gconv_path: "decides which converter libraries load",
  hostaliases: "decides how names resolve",
  classpath: "decides which classes load",
  jdk_java_options: "options for the Java launcher",
  _java_options: "options for the Java launcher",
  java_tool_options: "options for the Java launcher",
  mavenopts: "options for a build tool",
  dotnet_startup_hooks: "code that dotnet runs at start",
  phprc: "decides which PHP config loads",
  php_ini_scan_dir: "decides which PHP config loads",
  lua_init: "code that Lua runs at start",
  lua_path: "decides which Lua code loads",
  goflags: "flags for the go tool",
  goroot: "decides which Go toolchain runs",
  gopath: "decides which Go code loads",
  cc: "names the compiler",
  cxx: "names the compiler",
  cpp: "names the preprocessor",
  ld: "names the linker",
  rustc: "names the compiler",
  rustc_wrapper: "a program that wraps the compiler",
  rustc_workspace_wrapper: "a program that wraps the compiler",
  rustflags: "flags for the compiler",
  makeflags: "flags for make",
  makefiles: "makefiles that make reads",
  library_path: "decides which libraries link",
  compiler_path: "decides which compiler parts run",
  gcc_exec_prefix: "decides which compiler parts run",
  node_tls_reject_unauthorized: "turns off certificate checks",
  git_ssl_no_verify: "turns off certificate checks",
  sslkeylogfile: "writes TLS keys to a file",
  openssl_conf: "decides which OpenSSL config loads",
  openssl_modules: "decides which OpenSSL modules load",
  openssl_conf_include: "decides which OpenSSL config loads",
  openssl_config: "decides which OpenSSL config loads",
  openssl_engines: "decides which OpenSSL engines load",
  openssl: "names the openssl program that scripts run",
  aws_config_file:
    "a file whose profile can name a program that supplies credentials",
  aws_shared_credentials_file:
    "a file whose profile can name a program that supplies credentials",
  psmoduleanalysiscachepath:
    "decides which cached command list PowerShell reads",
  rustdoc: "names the documentation tool",
  rustfmt: "names the formatter",
  rustdocflags: "flags for the documentation tool",
};

/** `[prefix, why]`: any name that starts with the prefix. */
const DANGEROUS_PREFIXES: [string, string][] = [
  ["ld_", "loads libraries into the program"],
  ["dyld_", "loads libraries into the program"],
  ["bash_func_", "defines a shell function"],
  ["git_", "changes what git runs, reads or writes"],
  ["python", "changes which Python code loads"],
  ["ruby", "changes which Ruby code loads"],
  ["perl", "changes which Perl code loads"],
  ["gem_", "changes which Ruby gems load"],
  ["bundle_", "changes which gems bundler installs"],
  ["npm_config_", "sets any npm option, including the script shell"],
  ["pip_", "sets any pip option, including the package index"],
  ["cargo_", "sets any cargo option, including a wrapper program"],
  ["yarn_", "sets any yarn option"],
  ["pnpm_", "sets any pnpm option"],
  ["uv_", "sets any uv option"],
  ["poetry_", "sets any poetry option"],
  ["composer_", "sets any composer option"],
  ["gradle_", "options for a build tool"],
  ["maven_", "options for a build tool"],
  ["cgo_", "flags for the C compiler go runs"],
  ["tf_cli_", "adds arguments to terraform"],
  ["psexecutionpolicy", "changes PowerShell's script policy"],
];

/** Endings that say the value is a program, a wrapper, a path to load from or an option string. */
const DANGEROUS_SUFFIXES: [string, string][] = [
  ["_options", "options for a program, often loading code"],
  ["_opts", "options for a program, often loading code"],
  ["opt", "options for a program, often loading code"],
  ["_path", "decides where code loads from"],
  ["lib", "decides where code loads from"],
  ["_command", "a command that a program runs"],
  ["_wrapper", "a program that wraps another"],
  ["_askpass", "a program that asks for a password"],
  ["_editor", "a program that tools start"],
  ["_pager", "a program that tools start"],
  ["_preload", "loads libraries into the program"],
  ["_hooks", "code that runs at start"],
];

/** Where the network goes and which certificates are trusted. */
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/_proxy$/i, "sends traffic through another host"],
  [
    /^(ssl|curl|requests|node_extra)_ca|_ca_bundle$|_ca_certs$/i,
    "decides which certificates are trusted",
  ],
  [/^ssl_cert_(file|dir)$/i, "decides which certificates are trusted"],
  [/^(aws|azure|gcp|google|cloudsdk)_/i, "cloud credentials or endpoints"],
  [
    /^(kubeconfig|docker_|dockerconfig)/i,
    "points a client at another cluster or daemon",
  ],
  [/^(tmpdir|temp|tmp)$/i, "decides where temporary files go"],
  [/^xdg_/i, "decides where tools keep files"],
  [
    /^(java|gradle|cargo|rustup|go|dotnet|npm|node)_home$|_home$/i,
    "decides which toolchain runs",
  ],
  [/^dotnet_/i, "changes how dotnet runs"],
  [/^(ssh_auth_sock|gpg_agent_info)$/i, "points at another agent"],
  [/^(http|https|ftp|all|no)_proxy$/i, "sends traffic through another host"],
];

function listMatches(
  list: readonly string[] | undefined,
  name: string,
): boolean {
  const lower = name.toLowerCase();
  return (list ?? []).some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.endsWith("*") ? lower.startsWith(e.slice(0, -1)) : lower === e;
  });
}

/**
 * Classify a variable name by the built-in lists alone. The person's own
 * `allow` and `ask` lists are applied on top by `classifyEnvName`.
 */
function builtinClass(name: string): EnvClass {
  const lower = name.toLowerCase();
  if (
    HARMLESS.has(lower) ||
    HARMLESS_PREFIXES.some((p) => lower.startsWith(p))
  ) {
    return { risk: "harmless", why: "inert" };
  }
  const exact = Object.hasOwn(DANGEROUS_EXACT, lower)
    ? DANGEROUS_EXACT[lower]
    : undefined;
  if (exact) return { risk: "dangerous", why: exact };
  for (const [prefix, why] of DANGEROUS_PREFIXES) {
    if (lower.startsWith(prefix)) return { risk: "dangerous", why };
  }
  for (const [suffix, why] of DANGEROUS_SUFFIXES) {
    if (lower.endsWith(suffix)) return { risk: "dangerous", why };
  }
  for (const [re, why] of SENSITIVE_PATTERNS) {
    if (re.test(name)) return { risk: "sensitive", why };
  }
  if (isSecretName(name) || looksSecret(name)) {
    return { risk: "sensitive", why: "a credential variable" };
  }
  return { risk: "unknown", why: "no known effect" };
}

/**
 * Classify a variable name. Pure: the value is judged separately
 * (`valueRunsCode`). An `ask` entry always raises a name. An `allow` entry
 * lowers a name only from sensitive or unknown: a name the built-in policy
 * marks dangerous stays dangerous, because it asks at every level and a
 * config entry must not remove that floor.
 */
export function classifyEnvName(
  name: string,
  options: EnvNameOptions = {},
): EnvClass {
  const base = builtinClass(name);
  if (listMatches(options.ask, name)) {
    return base.risk === "dangerous"
      ? base
      : { risk: "dangerous", why: "listed in your config" };
  }
  if (base.risk !== "dangerous" && listMatches(options.allow, name)) {
    return { risk: "harmless", why: "allowed in your config" };
  }
  return base;
}

/**
 * Does the value run code when the shell expands it: `$(...)`, backticks,
 * process substitution, `${x@P}` and the like? Single quotes hide these, but
 * the scan is a text scan and ignores them, which only asks more often.
 */
export function valueRunsCode(value: string): boolean {
  return /\$\(|`|<\(|>\(|\$\{[^}]*@[PQEAaK]/.test(value);
}
