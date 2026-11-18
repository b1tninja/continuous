/**
 * Facts about the machine a command will run on, as pure functions over
 * injected inputs (plans/research/env-nonwindows-remote-and-facts.md, EV43).
 * Nothing here reads the process, a file or the network, and nothing is wired
 * into a prompt: a caller gathers the strings and passes them in, so the
 * tests need no real machine.
 *
 * Every answer carries a confidence, because a wrong claim about the
 * environment costs more than saying nothing:
 * - `known`: the inputs state it (the platform string, a shell we start).
 * - `likely`: a hint, such as a marker file, that is usually right.
 * - `unknown`: the inputs do not say; a caller must stay silent or say so.
 *
 * The shell family reuses `shellKindOf` from ./shell rather than naming
 * shells a second time.
 */
import { shellKindOf, type ShellKind } from "./shell";

export type Confidence = "known" | "likely" | "unknown";

export interface Fact<T extends string> {
  value: T;
  confidence: Confidence;
  /** What the answer came from, in words a person can read */
  source: string;
}

export type OsFamily = "windows" | "macos" | "linux" | "other" | "unknown";

/** `process.platform` or `os.platform()` to an OS family. */
export function osFamilyOf(platform: string | undefined): Fact<OsFamily> {
  switch (platform) {
    case "win32":
      return fact("windows", "known", "platform win32");
    case "darwin":
      return fact("macos", "known", "platform darwin");
    case "linux":
      return fact("linux", "known", "platform linux");
    case undefined:
    case "":
      return fact("unknown", "unknown", "no platform given");
    default:
      // freebsd, openbsd, sunos, aix, android: real, but not a family we
      // write advice for
      return fact("other", "known", `platform ${platform}`);
  }
}

export type ShellFamily =
  | "posix"
  | "zsh"
  | "bash"
  | "powershell"
  | "cmd"
  | "fish"
  | "nushell"
  | "csh"
  | "ksh"
  | "xonsh"
  | "unknown";

/** Shells `shellKindOf` does not name, by executable name. */
const OTHER_SHELLS: Record<string, ShellFamily> = {
  fish: "fish",
  nu: "nushell",
  nushell: "nushell",
  csh: "csh",
  tcsh: "csh",
  ksh: "ksh",
  ksh93: "ksh",
  mksh: "ksh",
  xonsh: "xonsh",
};

function baseName(executable: string): string {
  return (
    executable
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? ""
  );
}

function fromKind(kind: ShellKind): ShellFamily {
  return kind === "sh" ? "posix" : kind === "unknown" ? "unknown" : kind;
}

/**
 * The shell family named by a `$SHELL` or `ComSpec` style string. The login
 * shell is not necessarily the shell in use, so this is `likely` when it came
 * from the environment and `known` only when the caller says it started the
 * shell itself (`started`).
 */
export function shellFamilyOf(
  executable: string | undefined,
  opts: { started?: boolean } = {},
): Fact<ShellFamily> {
  if (!executable?.trim()) {
    return fact("unknown", "unknown", "no shell given");
  }
  const name = baseName(executable.trim());
  const kind = shellKindOf(executable);
  const family = kind === "unknown" ? OTHER_SHELLS[name] : fromKind(kind);
  if (!family) return fact("unknown", "unknown", `unrecognised shell ${name}`);
  return opts.started
    ? fact(family, "known", `the shell this process starts (${name})`)
    : fact(
        family,
        "likely",
        `login shell named ${name}; the shell in use may differ`,
      );
}

export type Locality = "local" | "remote";

/**
 * Whether the editor window is remote, from `vscode.env.remoteName` as
 * `getIdeInfo` reports it ("local" for undefined; JetBrains reports "ssh" or
 * "local"). `remoteName` is `known` when it is one of the names the
 * remote extensions use; an unrecognised non-local value is still remote.
 */
export function localityOf(remoteName: string | undefined): Fact<Locality> {
  const name = (remoteName ?? "").trim().toLowerCase();
  if (name === "" || name === "local" || name === "na") {
    return fact("local", "known", "editor reports no remote");
  }
  return fact("remote", "known", `editor reports remote "${name}"`);
}

export type Userland = "gnu" | "bsd" | "busybox" | "unknown";

export interface UserlandInputs {
  platform?: string;
  /** The target of the `/bin/sed` symlink or of `/bin/sh`, when read */
  sedLinkTarget?: string;
  /** Whether `/etc/alpine-release` exists */
  alpineRelease?: boolean;
  /** The `ID=` and `ID_LIKE=` words of `/etc/os-release`, when read */
  osReleaseIds?: readonly string[];
}

/**
 * A guess at the default userland a command meets: BSD on macOS and the BSDs,
 * busybox on Alpine, GNU on other Linux. It is a guess: a Homebrew `gnubin`
 * first on PATH makes macOS's `sed` GNU, which nothing here can see, so the
 * answer is never `known` and callers should say "default tools" not "tools".
 */
export function userlandOf(inputs: UserlandInputs): Fact<Userland> {
  const { platform } = inputs;
  if (platform === "darwin") {
    return fact(
      "bsd",
      "likely",
      "macOS tools are BSD unless GNU ones lead PATH",
    );
  }
  if (platform === "freebsd" || platform === "openbsd") {
    return fact("bsd", "likely", `platform ${platform}`);
  }
  if (platform === "linux") {
    const ids = (inputs.osReleaseIds ?? []).map((s) => s.toLowerCase());
    if (inputs.alpineRelease || ids.includes("alpine")) {
      return fact("busybox", "likely", "Alpine Linux (musl and busybox)");
    }
    if (/busybox/i.test(inputs.sedLinkTarget ?? "")) {
      return fact("busybox", "likely", "sed is a busybox applet");
    }
    return fact("gnu", "likely", "Linux, no sign of busybox");
  }
  return fact("unknown", "unknown", "no platform, or not a Unix");
}

export interface ContainerInputs {
  /** Whether `/.dockerenv` exists */
  dockerenv?: boolean;
  /** Whether `/run/.containerenv` exists */
  containerenv?: boolean;
  /** `process.env.CODESPACES` */
  codespaces?: string;
  /** `process.env.REMOTE_CONTAINERS` (set by the Dev Containers extension; unverified) */
  remoteContainers?: string;
  /** The text of `/proc/1/cgroup`, when read */
  cgroupText?: string;
}

export interface ContainerHint {
  /** `likely` at best: a marker is not proof, and never means a jail */
  inContainer: Fact<"yes" | "no" | "unknown">;
  markers: string[];
}

/**
 * Hints that the process is inside a container. Absence of every marker is
 * `unknown`, not `no`: a container with none of these files exists.
 */
export function containerHintOf(inputs: ContainerInputs): ContainerHint {
  const markers: string[] = [];
  if (inputs.dockerenv) markers.push("/.dockerenv");
  if (inputs.containerenv) markers.push("/run/.containerenv");
  if (inputs.codespaces === "true") markers.push("CODESPACES=true");
  if (inputs.remoteContainers === "true")
    markers.push("REMOTE_CONTAINERS=true");
  if (/(docker|kubepods|containerd|libpod)/i.test(inputs.cgroupText ?? "")) {
    markers.push("/proc/1/cgroup");
  }
  if (markers.length === 0) {
    return {
      inContainer: fact("unknown", "unknown", "no container marker seen"),
      markers,
    };
  }
  return {
    inContainer: fact("yes", "likely", `marker: ${markers.join(", ")}`),
    markers,
  };
}

/** Whether a Linux kernel version string (`/proc/version`) is WSL's. */
export function isWslVersionString(
  procVersion: string | undefined,
  wslDistroName?: string,
): Fact<"yes" | "no" | "unknown"> {
  if (wslDistroName) return fact("yes", "known", "WSL_DISTRO_NAME is set");
  if (procVersion === undefined) {
    return fact("unknown", "unknown", "/proc/version not read");
  }
  return /microsoft|wsl/i.test(procVersion)
    ? fact("yes", "likely", "/proc/version names Microsoft or WSL")
    : fact("no", "likely", "/proc/version has no WSL marker");
}

export interface EnvironmentFactsInput {
  platform?: string;
  arch?: string;
  shell?: string;
  /** True when this process starts the shell itself */
  shellStarted?: boolean;
  remoteName?: string;
  userland?: Omit<UserlandInputs, "platform">;
  container?: ContainerInputs;
}

export interface EnvironmentFacts {
  os: Fact<OsFamily>;
  arch?: string;
  shell: Fact<ShellFamily>;
  locality: Fact<Locality>;
  userland: Fact<Userland>;
  container: ContainerHint;
}

/**
 * All the facts at once. In a remote window the platform and shell are those
 * of the process asking, which may not be the machine the command runs on
 * (extensionKind ["ui","workspace"]): when `remoteName` says remote, the OS,
 * shell and userland are downgraded to `unknown` instead of being asserted.
 */
export function environmentFactsOf(
  input: EnvironmentFactsInput,
): EnvironmentFacts {
  const locality = localityOf(input.remoteName);
  const remote = locality.value === "remote";
  const unknownBecauseRemote = (what: string) =>
    fact(
      "unknown" as const,
      "unknown" as const,
      `${what} of a remote machine is not known`,
    );
  return {
    os: remote ? unknownBecauseRemote("the OS") : osFamilyOf(input.platform),
    arch: remote ? undefined : input.arch,
    shell: remote
      ? unknownBecauseRemote("the shell")
      : shellFamilyOf(input.shell, { started: input.shellStarted }),
    locality,
    userland: remote
      ? unknownBecauseRemote("the userland")
      : userlandOf({ ...input.userland, platform: input.platform }),
    container: containerHintOf(input.container ?? {}),
  };
}

function fact<T extends string>(
  value: T,
  confidence: Confidence,
  source: string,
): Fact<T> {
  return { value, confidence, source };
}
