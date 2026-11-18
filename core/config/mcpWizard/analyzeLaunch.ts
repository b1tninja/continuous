import { lintCommand } from "../../tools/permissions/commandLint";
import { maskCommandForDisplay } from "../../tools/permissions/displayMask";
import { fetchAndRunHit } from "../../tools/permissions/fetchAndRun";
import { missingBinaryProblem } from "../../tools/permissions/missingBinary";

import { joinShellWords } from "./shellWords";
import type { McpCandidate, McpServerDraft } from "./types";
import {
  foreignVariablesIn,
  isCredentialHeader,
  isPlaceholderValue,
  looksLikeSecretValue,
  referenceIn,
} from "./valueHints";

/*
  MCPW2: what is risky about starting or connecting to a server, decided
  from the text alone (plans/research/mcp-server-wizard.md section 5.1 item
  4). Local only: no lookup, no network, nothing run. The string-based
  permission helpers (`fetchAndRunHit`, `lintCommand`,
  `missingBinaryProblem`) read a shell line, while a server is a program plus
  an argv; the argv is joined with the quoting the display uses, so an
  argument holding `&` or a quote stays one word, as it is when the server
  is started without a shell.
*/

export type LaunchLevel = "block" | "warn" | "info";

export type LaunchFindingCode =
  | "fetch-and-run"
  | "unpinned-package"
  | "auto-yes"
  | "shell-wrapper"
  | "shell-script-problem"
  | "docker-privileged"
  | "docker-root-mount"
  | "docker-socket-mount"
  | "docker-home-mount"
  | "docker-host-namespace"
  | "docker-extra-privileges"
  | "docker-unpinned-image"
  | "secret-literal"
  | "placeholder-value"
  | "unfilled-variable"
  | "plaintext-http"
  | "loopback-http"
  | "private-address"
  | "windows-cmd-metacharacter"
  | "command-not-found"
  | "path-outside-workspace";

/** Offered when a literal credential can become a `${{ secrets.NAME }}` reference. */
export interface SecretReferenceFix {
  kind: "secret-reference";
  where: "env" | "header" | "arg" | "url";
  /** The variable or header name, the argument index, or the URL part */
  key: string;
  suggestedName: string;
}

export interface LaunchFinding {
  code: LaunchFindingCode;
  level: LaunchLevel;
  /** One sentence, safe to show and to read aloud: never holds a value. */
  message: string;
  fix?: SecretReferenceFix;
}

export interface LaunchAnalysis {
  findings: LaunchFinding[];
  /** True when any finding blocks Save and Test. */
  blocked: boolean;
  /** The command or URL as the review screen shows it, credentials masked. */
  display: string;
}

export interface AnalyzeOptions {
  /** Where the server would start; the Windows cmd check applies on win32. */
  platform?: NodeJS.Platform;
  /** When given, a command that is certainly missing is reported. */
  hasProgram?: (name: string) => boolean;
  /** When given, absolute paths outside it are named. */
  workspaceDir?: string;
  homeDir?: string;
}

type Entry = McpCandidate | McpServerDraft;

interface Value {
  name: string;
  value?: string;
  /** Already a secret (a draft value the person marked, or a reference). */
  handled: boolean;
  secretLooking: boolean;
  placeholder: boolean;
}

function valuesOf(list: Entry["env"] | Entry["headers"]): Value[] {
  return (list ?? []).map((v) => {
    if ("secret" in v) {
      const handled = v.secret || !!referenceIn(v.value);
      return {
        name: v.name,
        value: v.value,
        handled,
        secretLooking: !handled && looksLikeSecretValue(v.name, v.value),
        placeholder: !handled && isPlaceholderValue(v.value),
      };
    }
    return {
      name: v.name,
      value: v.value,
      handled: !!v.reference,
      secretLooking: v.value !== undefined && v.secretLooking,
      placeholder: v.placeholder,
    };
  });
}

/** `<SERVER>_<KEY>`, the importer's naming rule (core/config/importClineMcp.ts). */
export function suggestedSecretName(server: string, key: string): string {
  const part = (s: string) =>
    s
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
  const s = part(server);
  const k = part(key);
  let base = k.startsWith(`${s}_`) || !s ? k : `${s}_${k}`;
  if (!base) base = "MCP_SECRET";
  if (/^[0-9]/.test(base)) base = `MCP_${base}`;
  return base;
}

const NODE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const WINDOWS_BATCH = new Set([
  "npx",
  "uv",
  "uvx",
  "pnpx",
  "dlx",
  "nx",
  "bunx",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "fish", "ksh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * The program the wrapper eventually runs, as words, or a script text when
 * the wrapper takes one (`sh -c "..."`, `powershell -Command "..."`).
 */
function unwrapShell(
  command: string,
  args: string[],
): {
  wrapper?: "posix" | "cmd" | "powershell";
  words?: string[];
  script?: string;
} {
  const prog = programName(command);
  if (SHELLS.has(prog)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (c >= 0) return { wrapper: "posix", script: args[c + 1] ?? "" };
    return {};
  }
  if (prog === "cmd") {
    const c = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (c >= 0) return { wrapper: "cmd", words: args.slice(c + 1) };
    return {};
  }
  if (POWERSHELLS.has(prog)) {
    const c = args.findIndex((a) =>
      /^-(?:c|command|e|ec|encodedcommand)$/i.test(a),
    );
    if (c >= 0) {
      return { wrapper: "powershell", script: args.slice(c + 1).join(" ") };
    }
    return {};
  }
  return {};
}

export function analyzeLaunch(
  entry: Entry,
  opts: AnalyzeOptions = {},
): LaunchAnalysis {
  const findings: LaunchFinding[] = [];
  const add = (f: LaunchFinding) => {
    if (!findings.some((x) => x.code === f.code && x.message === f.message)) {
      findings.push(f);
    }
  };
  let display: string;
  if (entry.transport === "stdio" && entry.command) {
    const args = entry.args ?? [];
    display = maskCommandForDisplay(joinShellWords([entry.command, ...args]));
    analyzeCommand(entry, entry.command, args, opts, add);
  } else {
    display = entry.url ? maskCommandForDisplay(entry.url) : "";
    if (entry.url) analyzeUrl(entry, entry.url, add);
  }
  analyzeValues(entry, add);
  const order: Record<LaunchLevel, number> = { block: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    findings,
    blocked: findings.some((f) => f.level === "block"),
    display,
  };
}

function analyzeCommand(
  entry: Entry,
  command: string,
  args: string[],
  opts: AnalyzeOptions,
  add: (f: LaunchFinding) => void,
) {
  const line = joinShellWords([command, ...args]);
  const unwrapped = unwrapShell(command, args);
  const scripts = [
    unwrapped.script,
    ...args.filter((a) => /[|;&`$(]/.test(a)),
  ].filter((s): s is string => !!s);
  if (fetchAndRunHit(line) || scripts.some((s) => fetchAndRunHit(s))) {
    add({
      code: "fetch-and-run",
      level: "block",
      message:
        "This command downloads a script and runs it. Continuous cannot tell what the script will do.",
    });
  }

  if (unwrapped.wrapper) {
    add({
      code: "shell-wrapper",
      level: "warn",
      message:
        unwrapped.wrapper === "cmd"
          ? "This runs through cmd.exe. Prefer the program itself: Continuous already starts npx and uvx through cmd.exe on Windows when it has to."
          : "This runs through a shell. Prefer the program itself, so what runs is exactly what you see.",
    });
    if (unwrapped.script) {
      const shell = unwrapped.wrapper === "powershell" ? "powershell" : "bash";
      for (const f of lintCommand(unwrapped.script, shell)) {
        if (f.severity !== "error") continue;
        add({
          code: "shell-script-problem",
          level: "warn",
          message: `The script given to the shell has a problem: ${f.message}`,
        });
      }
    }
  }

  // What actually starts, after a wrapper such as `cmd /c npx ...`
  const words = unwrapped.words?.length
    ? unwrapped.words
    : unwrapped.script === undefined
      ? [command, ...args]
      : [];
  if (words.length) {
    const prog = programName(words[0]);
    checkPackagePin(prog, words.slice(1), add);
    if (prog === "docker" || prog === "podman") {
      checkDocker(words.slice(1), opts, add);
    }
    if (
      opts.platform === "win32" &&
      (WINDOWS_BATCH.has(prog) || unwrapped.wrapper === "cmd")
    ) {
      const bad = words.slice(1).filter((a) => /[&|<>^%]/.test(a));
      if (bad.length) {
        add({
          code: "windows-cmd-metacharacter",
          level: "block",
          message:
            "An argument contains a character that the Windows command interpreter treats as a command separator (& | < > ^ %). Remove it, or start the program without npx or cmd.",
        });
      }
    }
  }

  if (opts.hasProgram && !/[\\/]/.test(command)) {
    const problem = missingBinaryProblem(joinShellWords([command]), {
      shell: opts.platform === "win32" ? "cmd" : "bash",
      hasProgram: opts.hasProgram,
    });
    if (problem) {
      add({
        code: "command-not-found",
        level: "warn",
        message: `\`${problem.program}\` was not found on the PATH. Install it, or give the full path.`,
      });
    }
  }

  // Arguments that hold a credential, or a placeholder for one
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const prev = args[i - 1] ?? "";
    const flagged =
      /^--?(?:[a-z-]*(?:token|key|secret|password|auth)[a-z-]*)$/i.test(prev);
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(a);
    const isEnvArg = assign && /^(?:-e|--env)$/.test(prev);
    const shaped = maskCommandForDisplay(a) !== a;
    const name = isEnvArg
      ? assign![1]
      : flagged
        ? prev.replace(/^-+/, "")
        : `arg${i}`;
    const value = isEnvArg ? assign![2] : a;
    if (referenceIn(value)) continue;
    if (
      shaped ||
      ((flagged || isEnvArg) && looksLikeSecretValue(name, value))
    ) {
      add({
        code: "secret-literal",
        level: "warn",
        message: `Argument ${i + 1} looks like a key. It will be stored as a secret and replaced by a reference.`,
        fix: {
          kind: "secret-reference",
          where: "arg",
          key: String(i),
          suggestedName: suggestedSecretName(entry.name, name),
        },
      });
    } else if ((flagged || isEnvArg) && isPlaceholderValue(value)) {
      add({
        code: "placeholder-value",
        level: "warn",
        message: `Argument ${i + 1} is an example value from the instructions. Replace it with your own.`,
      });
    }
  }

  const foreign = [command, ...args, entry.cwd ?? ""].flatMap(
    foreignVariablesIn,
  );
  if (foreign.length) {
    add({
      code: "unfilled-variable",
      level: "warn",
      message: `Continuous does not fill in ${[...new Set(foreign)].map((v) => "${" + v + "}").join(", ")}. Replace it with a real value.`,
    });
  }

  if (opts.workspaceDir) {
    const outside = args.filter(
      (a) => isAbsolutePath(a) && !isInside(a, opts.workspaceDir!),
    );
    if (outside.length) {
      add({
        code: "path-outside-workspace",
        level: "info",
        message: `The server is given ${outside.length === 1 ? "a folder" : "folders"} outside this workspace: ${outside.join(", ")}.`,
      });
    }
  }
}

/** The package a runner starts, and whether it names an exact version. */
function checkPackagePin(
  prog: string,
  rest: string[],
  add: (f: LaunchFinding) => void,
) {
  let spec: string | undefined;
  let python = false;
  if (NODE_RUNNERS.has(prog)) {
    spec = firstPackage(rest, new Set(["-p", "--package"]), true);
  } else if ((prog === "pnpm" || prog === "yarn") && rest[0] === "dlx") {
    spec = firstPackage(rest.slice(1), new Set(["-p", "--package"]), true);
  } else if (prog === "npm" && rest[0] === "exec") {
    spec = firstPackage(rest.slice(1), new Set(["-p", "--package"]), true);
  } else if (prog === "uvx" || (prog === "uv" && rest[0] === "tool")) {
    python = true;
    const r = prog === "uv" ? rest.slice(2) : rest;
    const from = r.indexOf("--from");
    spec =
      from >= 0
        ? r[from + 1]
        : firstPackage(r, new Set(["--with", "--python", "-p"]), false);
  } else if (prog === "pipx" && rest[0] === "run") {
    python = true;
    const s = rest.indexOf("--spec");
    spec = s >= 0 ? rest[s + 1] : firstPackage(rest.slice(1), new Set(), false);
  } else {
    return;
  }
  if (NODE_RUNNERS.has(prog) && rest.some((a) => a === "-y" || a === "--yes")) {
    add({
      code: "auto-yes",
      level: "info",
      message: "`-y` installs the package without asking.",
    });
  }
  if (!spec || isLocalSpec(spec)) return;
  if (pinned(spec, python)) return;
  add({
    code: "unpinned-package",
    level: "warn",
    message: python
      ? `${packageName(spec, true)} is not pinned to a version. A later release could change what runs on your machine. Pin it, for example ${packageName(spec, true)}==1.2.3.`
      : `${packageName(spec, false)} is not pinned to a version. A later release could change what runs on your machine. Pin it, for example ${packageName(spec, false)}@1.2.3.`,
  });
}

function firstPackage(
  words: string[],
  withValue: Set<string>,
  node: boolean,
): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (withValue.has(w)) {
      // `npx -p pkg cmd`: the package is the option's value
      if (node) return words[i + 1];
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    return w;
  }
  return undefined;
}

function isLocalSpec(spec: string): boolean {
  return (
    /^(?:\.{1,2}[\\/]|[\\/]|~|file:|[A-Za-z]:\\)/.test(spec) ||
    /^(?:git\+|https?:|github:)/.test(spec)
  );
}

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function pinned(spec: string, python: boolean): boolean {
  if (python) {
    const eq = /^[A-Za-z0-9._\[\],-]+==(.+)$/.exec(spec);
    if (eq) return /^\d+(?:\.\d+)*(?:[a-z0-9.+-]*)$/i.test(eq[1]);
    const at = /^[A-Za-z0-9._-]+@(.+)$/.exec(spec);
    return !!at && /^\d+(?:\.\d+)+/.test(at[1]);
  }
  const m = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(spec);
  return !!m && EXACT.test(m[2]);
}

function packageName(spec: string, python: boolean): string {
  if (python) return spec.replace(/(?:==|@|>=|~=).*$/, "");
  return spec.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, "$1");
}

function checkDocker(
  rest: string[],
  opts: AnalyzeOptions,
  add: (f: LaunchFinding) => void,
) {
  if (rest[0] !== "run") return;
  const mounts: string[] = [];
  let image: string | undefined;
  const withValue = new Set([
    "-e",
    "--env",
    "--name",
    "-p",
    "--publish",
    "--entrypoint",
    "-u",
    "--user",
    "-w",
    "--workdir",
    "--env-file",
    "--platform",
    "--add-host",
    "--label",
    "-l",
  ]);
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    const [flag, inline] =
      a.startsWith("--") && a.includes("=")
        ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
        : [a, undefined];
    const value = () => inline ?? rest[++i] ?? "";
    if (flag === "--privileged") {
      add({
        code: "docker-privileged",
        level: "block",
        message:
          "This container runs with --privileged, which gives it full control of your computer.",
      });
      continue;
    }
    if (flag === "-v" || flag === "--volume") {
      // `src:dst[:opts]`; a Windows source keeps its drive letter
      mounts.push(/^(?:[A-Za-z]:[\\/][^:]*|[^:]*)/.exec(value())?.[0] ?? "");
      continue;
    }
    if (flag === "--mount") {
      const m = /(?:^|,)(?:src|source)=([^,]+)/.exec(value());
      if (m) mounts.push(m[1]);
      continue;
    }
    if (
      ["--network", "--net", "--pid", "--ipc", "--uts", "--userns"].includes(
        flag,
      )
    ) {
      if (value() === "host") {
        add({
          code: "docker-host-namespace",
          level: "warn",
          message: `This container shares the computer's ${flag.replace(/^--/, "")} (${flag} host). It can reach your files or network beyond what a tool needs.`,
        });
      }
      continue;
    }
    if (
      flag === "--cap-add" ||
      flag === "--device" ||
      flag === "--security-opt"
    ) {
      const v = value();
      add({
        code: "docker-extra-privileges",
        level: "warn",
        message: `This container is given extra privileges (${flag} ${v}).`,
      });
      continue;
    }
    if (withValue.has(flag)) {
      if (inline === undefined) i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    image = a;
    break;
  }
  for (const src of mounts) {
    const s = src.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    if (/docker\.sock$|^\/\/\.\/pipe\/docker_engine$|podman\.sock$/.test(s)) {
      add({
        code: "docker-socket-mount",
        level: "block",
        message:
          "This container is given the Docker socket, which lets it start other containers with full control of your computer.",
      });
    } else if (s === "/" || /^[A-Za-z]:\/?$/.test(s)) {
      add({
        code: "docker-root-mount",
        level: "block",
        message: "This container is given your whole disk.",
      });
    } else if (isHomeFolder(s, opts.homeDir)) {
      add({
        code: "docker-home-mount",
        level: "warn",
        message:
          "This container is given your whole home folder. It can reach your files beyond what a tool needs.",
      });
    }
  }
  if (image && !image.includes("@sha256:")) {
    const tag = /:([^/:]+)$/.exec(image)?.[1];
    if (!tag || tag === "latest") {
      add({
        code: "docker-unpinned-image",
        level: "info",
        message:
          "The image is not pinned to a version or digest, so a later image could run.",
      });
    }
  }
}

function isHomeFolder(s: string, home?: string): boolean {
  if (/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)$/.test(s)) return true;
  if (/^\/(?:Users|home)\/[^/]+$/.test(s)) return true;
  if (/^[A-Za-z]:\/Users\/[^/]+$/i.test(s)) return true;
  return !!home && s === home.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAbsolutePath(a: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(a) && !/^\/[a-z]$/i.test(a);
}

function isInside(p: string, dir: string): boolean {
  const norm = (s: string) =>
    s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const a = norm(p);
  const d = norm(dir);
  return a === d || a.startsWith(`${d}/`);
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;
const PRIVATE =
  /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[f[cd][0-9a-f:]*\])$/i;

function analyzeUrl(
  entry: Entry,
  url: string,
  add: (f: LaunchFinding) => void,
) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    if (foreignVariablesIn(url).length) {
      add({
        code: "unfilled-variable",
        level: "warn",
        message:
          "The URL holds a variable that Continuous does not fill in. Replace it with the real address.",
      });
    }
    return;
  }
  const host = u.hostname;
  if (u.protocol === "http:") {
    if (LOOPBACK.test(host)) {
      add({
        code: "loopback-http",
        level: "info",
        message:
          "This server runs on this computer and the connection is not encrypted.",
      });
    } else {
      add({
        code: "plaintext-http",
        level: "block",
        message: "This connection is not encrypted. Use an https:// address.",
      });
    }
  }
  if (PRIVATE.test(host)) {
    add({
      code: "private-address",
      level: "info",
      message: "This address is on your local network.",
    });
  }
  if (u.password && maskCommandForDisplay(url) !== url) {
    add({
      code: "secret-literal",
      level: "warn",
      message:
        "The URL holds a password. It will be stored as a secret and replaced by a reference.",
      fix: {
        kind: "secret-reference",
        where: "url",
        key: "password",
        suggestedName: suggestedSecretName(entry.name, "password"),
      },
    });
  }
  for (const [k, v] of u.searchParams) {
    if (referenceIn(v)) continue;
    if (
      /key|token|secret|auth|passw|sig/i.test(k) &&
      !isPlaceholderValue(v) &&
      v.length >= 8
    ) {
      add({
        code: "secret-literal",
        level: "warn",
        message: `The URL parameter ${k} looks like a key. It will be stored as a secret and replaced by a reference.`,
        fix: {
          kind: "secret-reference",
          where: "url",
          key: k,
          suggestedName: suggestedSecretName(entry.name, k),
        },
      });
    }
  }
}

function analyzeValues(entry: Entry, add: (f: LaunchFinding) => void) {
  const env = valuesOf(entry.env);
  const headers = valuesOf(entry.headers);
  for (const [where, list] of [
    ["env", env],
    ["header", headers],
  ] as const) {
    for (const v of list) {
      if (v.handled) continue;
      const credentialHeader =
        where === "header" &&
        isCredentialHeader(v.name) &&
        v.value !== undefined &&
        !v.placeholder &&
        !/^(?:Bearer|Basic|Token)\s*$/i.test(v.value);
      if (v.secretLooking || credentialHeader) {
        add({
          code: "secret-literal",
          level: "warn",
          message: `${v.name} looks like a key. It will be stored as a secret and replaced by a reference.`,
          fix: {
            kind: "secret-reference",
            where,
            key: v.name,
            suggestedName: suggestedSecretName(entry.name, v.name),
          },
        });
      } else if (v.placeholder) {
        add({
          code: "placeholder-value",
          level: "warn",
          message: `${v.name} has an example value from the instructions. Replace it with your own.`,
        });
      }
    }
  }
}
