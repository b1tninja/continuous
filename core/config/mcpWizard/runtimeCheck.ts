import fs from "node:fs";

import { onPath } from "../../tools/permissions/missingBinaryGate";

/*
  MCPW10: is the program a server needs on the editor's PATH? One line for
  the review screen ("Node.js found", or "Node.js was not found: install
  it, then restart your editor") and a link to the vendor's install page.
  Nothing is installed, downloaded or started here: the check only looks
  for files on the PATH (with PATHEXT on Windows), so it is safe to run on
  every keystroke of the review form.

  Docker is reported as found when the `docker` program is on the PATH. The
  daemon is not asked (that would start a process), so the line says the
  Docker app must be running.
*/

export type McpRuntimeKind =
  "node" | "uv" | "docker" | "bun" | "python" | "other";

export interface McpRuntimeCheck {
  kind: McpRuntimeKind;
  /** "Node.js", "uv", "Docker", "Bun", "Python", or the program's name. */
  label: string;
  /** The programs looked for, in order; the first is the command itself. */
  programs: string[];
  /** Every program in `programs` is on the PATH. */
  found: boolean;
  /** The ones that are not. */
  missing: string[];
  /** One sentence for the review screen. */
  line: string;
  /** The install page; opened in the browser by the person, never fetched. */
  link?: string;
  /**
   * Windows only: npx, uvx and the other batch launchers are started through
   * cmd.exe, which splits arguments with spaces or quotes its own way.
   */
  windowsQuotingHint?: string;
}

export interface RuntimeCheckOptions {
  platform?: NodeJS.Platform;
  /** The environment whose PATH is searched; defaults to this process. */
  env?: Record<string, string | undefined>;
  /** For tests: whether a file exists. */
  isFile?: (file: string) => boolean;
}

interface RuntimeInfo {
  kind: McpRuntimeKind;
  label: string;
  /** Programs that must be present, besides the command itself. */
  needs: string[];
  link?: string;
}

/** The same pages the probe's hints and MCPConnection's errors use. */
export const RUNTIME_LINKS = {
  node: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  docker: "https://docs.docker.com/get-started/get-docker/",
  bun: "https://bun.sh/docs/installation",
  python: "https://www.python.org/downloads/",
} as const;

const NODE: RuntimeInfo = {
  kind: "node",
  label: "Node.js",
  needs: ["node"],
  link: RUNTIME_LINKS.node,
};
const UV: RuntimeInfo = {
  kind: "uv",
  label: "uv",
  needs: [],
  link: RUNTIME_LINKS.uv,
};

const RUNTIMES: Record<string, RuntimeInfo> = {
  npx: NODE,
  npm: NODE,
  pnpx: NODE,
  pnpm: NODE,
  yarn: NODE,
  node: { ...NODE, needs: [] },
  uvx: UV,
  uv: UV,
  docker: {
    kind: "docker",
    label: "Docker",
    needs: [],
    link: RUNTIME_LINKS.docker,
  },
  bunx: { kind: "bun", label: "Bun", needs: ["bun"], link: RUNTIME_LINKS.bun },
  bun: { kind: "bun", label: "Bun", needs: [], link: RUNTIME_LINKS.bun },
  python: {
    kind: "python",
    label: "Python",
    needs: [],
    link: RUNTIME_LINKS.python,
  },
  python3: {
    kind: "python",
    label: "Python",
    needs: [],
    link: RUNTIME_LINKS.python,
  },
  pipx: {
    kind: "python",
    label: "pipx",
    needs: [],
    link: "https://pipx.pypa.io/stable/installation/",
  },
};

/** Started through cmd.exe on Windows (MCPConnection and the probe agree). */
const WINDOWS_BATCH = new Set(["npx", "uv", "uvx", "pnpx", "bunx", "pnpm"]);

export const WINDOWS_QUOTING_HINT =
  "On Windows this server is started through cmd.exe, which splits an argument with spaces or quotes its own way. If the test fails, remove the quotes or use the JSON form.";

/** `C:\\tools\\npx.cmd` -> `npx`. */
export function runtimeProgramName(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * What the command needs and whether it is there. A command given as a path
 * is checked as a file, not looked up on the PATH.
 */
export function checkRuntime(
  command: string,
  args: string[] = [],
  opts: RuntimeCheckOptions = {},
): McpRuntimeCheck {
  const platform = opts.platform ?? process.platform;
  const prog = runtimeProgramName(command);
  const info: RuntimeInfo = RUNTIMES[prog] ?? {
    kind: "other",
    label: prog || command,
    needs: [],
  };
  const isPath = /[\\/]/.test(command.trim());
  const programs = [isPath ? command.trim() : prog, ...info.needs].filter(
    Boolean,
  );
  const lookup = (name: string): boolean => {
    if (/[\\/]/.test(name)) {
      return (opts.isFile ?? defaultIsFile)(name);
    }
    return onPath(name, { platform, env: opts.env, isFile: opts.isFile });
  };
  const missing = programs.filter((p) => !lookup(p));
  const found = programs.length > 0 && missing.length === 0;
  const result: McpRuntimeCheck = {
    kind: info.kind,
    label: info.label,
    programs,
    found,
    missing,
    line: runtimeLine(info, prog, found, missing),
    ...(info.link ? { link: info.link } : {}),
  };
  if (
    platform === "win32" &&
    WINDOWS_BATCH.has(prog) &&
    args.some((a) => /[\s"]/.test(a))
  ) {
    result.windowsQuotingHint = WINDOWS_QUOTING_HINT;
  }
  return result;
}

function runtimeLine(
  info: RuntimeInfo,
  prog: string,
  found: boolean,
  missing: string[],
): string {
  if (found) {
    return info.kind === "docker"
      ? "Docker found. The Docker app must be running when the server starts."
      : `${info.label} found.`;
  }
  if (info.kind === "other") {
    return `\`${missing[0] ?? prog}\` was not found on the PATH your editor uses. Give the full path, or start the editor from a terminal where it works.`;
  }
  const which =
    missing.length === 1 && missing[0] !== prog
      ? ` (\`${missing[0]}\` is missing)`
      : "";
  return `${info.label} was not found${which}. Install it, then restart your editor so the PATH is refreshed.`;
}

function defaultIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
