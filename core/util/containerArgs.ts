import {
  DEFAULT_CONTAINER_IMAGE,
  type ContainerRuntime,
} from "./containerStatus";
import { sourceEncodedArgs } from "./sourceEncoded";

export interface ContainerRunOptions {
  runtime: ContainerRuntime;
  image?: string;
  /** The workspace folder on the host: the only folder mounted */
  cwd: string;
  /**
   * Paths inside the workspace mounted again read-only, over the read-write
   * mount (`protectedMounts`): what the host runs or trusts later
   */
  readOnly?: readonly ReadOnlyMount[];
  platform?: NodeJS.Platform;
  /** Host user and group on Linux and macOS: the command runs as them, not root */
  user?: { uid: number; gid: number };
  /** `none` (the default) has no network at all */
  network?: "none" | "bridge";
  memory?: string;
  pids?: number;
}

/** One path of the workspace mounted again, read-only, over the read-write mount. */
export interface ReadOnlyMount {
  /** The path on the host, in the host's own spelling */
  host: string;
  /** Where it appears in the container */
  container: string;
}

/**
 * One value of `--mount` is a line of CSV, so a field that holds a comma or a
 * quote is quoted whole, with its quotes doubled.
 */
function mountField(field: string): string {
  return /[,"]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * The arguments for the read-only mounts. `--mount` and not `-v`: with `-v`
 * a host path that has gone since it was listed is created by the runtime (a
 * root-owned folder on the host), and with `--mount` the run fails instead.
 */
function readOnlyMountArgs(mounts: readonly ReadOnlyMount[]): string[] {
  return mounts.flatMap((m) => [
    "--mount",
    [
      "type=bind",
      mountField(`src=${m.host}`),
      mountField(`dst=${m.container}`),
      "readonly",
    ].join(","),
  ]);
}

/**
 * Where the workspace appears inside the container: the same path on Linux
 * and macOS, so paths in output and in the agent's head still hold, and
 * `/workspace` on Windows, where a drive path cannot be a Linux path.
 */
export function containerWorkdir(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "/workspace" : cwd;
}

/**
 * The whole `docker run` or `podman run` command line for one command, as
 * data so every flag can be tested without a runtime. What it sets, and why
 * each is there:
 *
 * - `--rm -i`: a fresh container per command, gone after it, standard input open
 * - `--network none`: no network unless asked
 * - `--cap-drop ALL`, `--security-opt no-new-privileges`: no capabilities, no gaining them
 * - `--read-only` and a small `tmpfs` at `/tmp`: the image cannot be changed; only `/tmp` and the workspace are writable
 * - `--pids-limit`, `--memory`: a runaway command cannot take the machine
 * - `--user uid:gid` (Linux and macOS): files written in the workspace belong to the person, not root
 * - one folder, the workspace, mounted read-write; no Docker socket, no other folder, no host environment
 * - `readOnly`: parts of the workspace mounted again read-only, after the workspace so they sit over it
 * - the command as base64 sourced by bash, so quotes and heredocs arrive exactly (see `sourceEncodedArgs`)
 */
export function containerArgs(
  command: string,
  opts: ContainerRunOptions,
): string[] {
  const platform = opts.platform ?? process.platform;
  const workdir = containerWorkdir(opts.cwd, platform);
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    opts.network ?? "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    "--pids-limit",
    String(opts.pids ?? 512),
    "--memory",
    opts.memory ?? "2g",
    ...(opts.user && platform !== "win32"
      ? ["--user", `${opts.user.uid}:${opts.user.gid}`]
      : []),
    // A user with no home in the image still has somewhere to write
    "-e",
    "HOME=/tmp",
    "-v",
    `${opts.cwd}:${workdir}:rw`,
    ...readOnlyMountArgs(opts.readOnly ?? []),
    "-w",
    workdir,
    opts.image ?? DEFAULT_CONTAINER_IMAGE,
    ...sourceEncodedArgs(command),
  ];
}
