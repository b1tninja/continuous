import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containerArgs, containerWorkdir } from "./containerArgs";
import {
  MAX_READ_ONLY_MOUNTS,
  protectedMounts,
} from "./containerProtectedMounts";
import {
  containerStatus,
  containerUnavailableMessage,
  DEFAULT_CONTAINER_IMAGE,
  pickContainerRuntime,
  type ContainerProbe,
  type ContainerStatus,
} from "./containerStatus";
import { getCommandExecutor } from "./commandExecutor";
import { parseTerminalShell, resolveShell, wslArgs } from "./shell";
import { sourceEncodedArgs } from "./sourceEncoded";

const ready: ContainerStatus = { state: "ready", runtime: "docker" };

describe("containerArgs", () => {
  const args = containerArgs("echo hi", {
    runtime: "docker",
    cwd: "/home/me/project",
    platform: "linux",
    user: { uid: 1000, gid: 1000 },
  });
  const value = (flag: string) => args[args.indexOf(flag) + 1];

  it("runs one throwaway container with standard input open", () => {
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
  });

  it("has no network, no capabilities and cannot gain privileges", () => {
    expect(value("--network")).toBe("none");
    expect(value("--cap-drop")).toBe("ALL");
    expect(value("--security-opt")).toBe("no-new-privileges");
  });

  it("makes the image read-only, with a small /tmp", () => {
    expect(args).toContain("--read-only");
    expect(value("--tmpfs")).toBe("/tmp:rw,nosuid,size=256m");
    expect(args).toContain("HOME=/tmp");
  });

  it("limits processes and memory", () => {
    expect(value("--pids-limit")).toBe("512");
    expect(value("--memory")).toBe("2g");
  });

  it("runs as the host user, not root", () => {
    expect(value("--user")).toBe("1000:1000");
  });

  it("mounts the workspace at the same path, and nothing else", () => {
    const mounts = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
    expect(mounts).toEqual(["/home/me/project:/home/me/project:rw"]);
    expect(value("-w")).toBe("/home/me/project");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--env-file");
  });

  it("ends with the image and bash sourcing the encoded command", () => {
    expect(args.slice(-4, -3)).toEqual([DEFAULT_CONTAINER_IMAGE]);
    expect(args.slice(-3)).toEqual(sourceEncodedArgs("echo hi"));
  });

  it("takes an image, a network and limits when given", () => {
    const custom = containerArgs("x", {
      runtime: "podman",
      image: "node:22-slim",
      cwd: "/w",
      platform: "linux",
      network: "bridge",
      memory: "512m",
      pids: 64,
    });
    expect(custom[custom.indexOf("--network") + 1]).toBe("bridge");
    expect(custom[custom.indexOf("--memory") + 1]).toBe("512m");
    expect(custom[custom.indexOf("--pids-limit") + 1]).toBe("64");
    expect(custom).toContain("node:22-slim");
    expect(custom).not.toContain("--user");
  });

  it("mounts a Windows folder at /workspace and sets no user", () => {
    expect(containerWorkdir("C:\\code\\p", "win32")).toBe("/workspace");
    const win = containerArgs("x", {
      runtime: "docker",
      cwd: "C:\\code\\p",
      platform: "win32",
      user: { uid: 1, gid: 1 },
    });
    expect(win).toContain("C:\\code\\p:/workspace:rw");
    expect(win[win.indexOf("-w") + 1]).toBe("/workspace");
    expect(win).not.toContain("--user");
  });

  it("sends the command with nothing for a command line to mangle", () => {
    const text = `cat <<'EOF'\n$HOME "x" 'y'\nEOF`;
    const last = containerArgs(text, { runtime: "docker", cwd: "/w" }).at(-1)!;
    expect(last).not.toMatch(/['"$]/);
    const encoded = /echo (\S+) \|/.exec(last)![1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(text);
  });

  it("shares its encoding with the WSL executor", () => {
    expect(wslArgs("echo hi", "Ubuntu").slice(-3)).toEqual(
      sourceEncodedArgs("echo hi"),
    );
  });
});

describe("the read-only mounts over the workspace (PS7)", () => {
  // A space and a comma in the path: `--mount` takes a line of CSV
  const base = mkdtempSync(join(tmpdir(), "ro mounts, "));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** A workspace with some of the protected paths present and some absent. */
  const workspace = (name: string, make: (ws: string) => void): string => {
    const ws = join(base, name);
    mkdirSync(ws);
    make(ws);
    return ws;
  };
  const tree = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  const mountsOf = (args: string[]) =>
    args.flatMap((a, i) => (args[i - 1] === "--mount" ? [a] : []));

  const ws = workspace("project", (w) => {
    mkdirSync(join(w, ".git", "hooks"), { recursive: true });
    writeFileSync(join(w, ".git", "config"), "[core]\n");
    writeFileSync(join(w, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(w, ".vscode"));
    mkdirSync(join(w, ".github", "workflows"), { recursive: true });
    mkdirSync(join(w, ".github", "ISSUE_TEMPLATE"));
    writeFileSync(join(w, ".envrc"), "");
    writeFileSync(join(w, "Jenkinsfile"), "");
    // The same names deeper in the tree are not looked for
    mkdirSync(join(w, "packages", "a", ".vscode"), { recursive: true });
    mkdirSync(join(w, "src"));
  });

  it("mounts each protected path that exists, and none that does not", () => {
    const before = tree(ws);
    const linux = protectedMounts(ws, { platform: "linux" });
    expect(linux).toEqual(
      [
        [".git", "hooks"],
        [".git", "config"],
        [".vscode"],
        [".github", "workflows"],
        [".envrc"],
        ["Jenkinsfile"],
      ].map((names) => ({
        host: [ws, ...names].join("/"),
        container: [ws, ...names].join("/"),
      })),
    );
    const said = linux.map((m) => m.container).join("\n");
    // Absent: no mount. Present but not on the list: no mount
    for (const absent of [".idea", ".devcontainer", ".husky", ".mcp.json"]) {
      expect(said).not.toContain(absent);
    }
    expect(said).not.toContain("ISSUE_TEMPLATE");
    expect(said).not.toContain("packages");
    expect(said).not.toContain("HEAD");
    // Nothing was created on the host
    expect(tree(ws)).toEqual(before);
  });

  it("is in the run arguments after the workspace mount, read-only, with the path quoted for CSV", () => {
    const args = containerArgs("git status", {
      runtime: "docker",
      cwd: ws,
      platform: "linux",
      readOnly: protectedMounts(ws, { platform: "linux" }),
    });
    const mounts = mountsOf(args);
    expect(mounts).toHaveLength(6);
    expect(mounts[0]).toBe(
      `type=bind,"src=${ws}/.git/hooks","dst=${ws}/.git/hooks",readonly`,
    );
    expect(mounts.every((m) => m.endsWith(",readonly"))).toBe(true);
    expect(args.indexOf("--mount")).toBeGreaterThan(args.indexOf("-v"));
    // The workspace itself is still the one read-write mount
    expect(args[args.indexOf("-v") + 1]).toBe(`${ws}:${ws}:rw`);
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
  });

  it("leaves a path without a comma or a quote as it is", () => {
    const args = containerArgs("x", {
      runtime: "podman",
      cwd: "/home/me/my project",
      platform: "linux",
      readOnly: [
        {
          host: "/home/me/my project/.vscode",
          container: "/home/me/my project/.vscode",
        },
        { host: '/w/a"b/.envrc', container: '/w/a"b/.envrc' },
      ],
    });
    expect(mountsOf(args)).toEqual([
      "type=bind,src=/home/me/my project/.vscode,dst=/home/me/my project/.vscode,readonly",
      'type=bind,"src=/w/a""b/.envrc","dst=/w/a""b/.envrc",readonly',
    ]);
  });

  it("on Windows names the host path with backslashes and the container path under /workspace", () => {
    const mounts = protectedMounts(ws, { platform: "win32" });
    expect(mounts[0]).toEqual({
      host: `${ws}\\.git\\hooks`,
      container: "/workspace/.git/hooks",
    });
    expect(mounts.map((m) => m.container)).toEqual([
      "/workspace/.git/hooks",
      "/workspace/.git/config",
      "/workspace/.vscode",
      "/workspace/.github/workflows",
      "/workspace/.envrc",
      "/workspace/Jenkinsfile",
    ]);
  });

  it("mounts a name in the spelling on disk, whatever its case", () => {
    const odd = workspace("case", (w) => mkdirSync(join(w, ".VSCode")));
    expect(protectedMounts(odd, { platform: "linux" })).toEqual([
      { host: `${odd}/.VSCode`, container: `${odd}/.VSCode` },
    ]);
  });

  it("mounts a .git that is a file (a worktree), since it names the hooks that run", () => {
    const worktree = workspace("worktree", (w) =>
      writeFileSync(join(w, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n"),
    );
    expect(protectedMounts(worktree, { platform: "linux" })).toEqual([
      { host: `${worktree}/.git`, container: `${worktree}/.git` },
    ]);
  });

  it("looks up the rest of an entry when the workspace is its first part", () => {
    const gitDir = workspace(".git", (w) => {
      mkdirSync(join(w, "hooks"));
      writeFileSync(join(w, "config"), "");
      mkdirSync(join(w, "objects"));
    });
    expect(
      protectedMounts(gitDir, { platform: "linux" }).map((m) => m.container),
    ).toEqual([`${gitDir}/hooks`, `${gitDir}/config`]);
  });

  it("keeps a workspace inside a protected folder writable, with the list still applied in it", () => {
    const inside = workspace(".claude", (w) => {
      mkdirSync(join(w, "worktrees", "x", ".vscode"), { recursive: true });
    });
    const cwd = join(inside, "worktrees", "x");
    const args = containerArgs("x", {
      runtime: "docker",
      cwd,
      platform: "linux",
      readOnly: protectedMounts(cwd, { platform: "linux" }),
    });
    expect(args[args.indexOf("-v") + 1]).toBe(`${cwd}:${cwd}:rw`);
    expect(mountsOf(args)).toHaveLength(1);
    expect(mountsOf(args)[0]).toContain(`${cwd}/.vscode`);
  });

  it("skips a symbolic link, which would mount what it points at", () => {
    const linked = workspace("linked", (w) => {
      mkdirSync(join(w, "real"));
      mkdirSync(join(w, ".idea"));
    });
    try {
      symlinkSync(join(linked, "real"), join(linked, ".vscode"), "junction");
    } catch {
      // No right to make a link here: the rest still holds
    }
    expect(
      protectedMounts(linked, { platform: "linux" }).map((m) => m.container),
    ).toEqual([`${linked}/.idea`]);
  });

  it("stops at the cap, in the list's order, and is empty for a folder that is not there", () => {
    expect(MAX_READ_ONLY_MOUNTS).toBe(64);
    expect(
      protectedMounts(ws, { platform: "linux", max: 2 }).map(
        (m) => m.container,
      ),
    ).toEqual([`${ws}/.git/hooks`, `${ws}/.git/config`]);
    expect(protectedMounts(join(base, "missing"))).toEqual([]);
    expect(readdirSync(base)).not.toContain("missing");
  });

  it("the executor adds them for the folder the command starts in", () => {
    const executor = getCommandExecutor({
      platform: "linux",
      terminalShell: { kind: "container" },
      containerStatus: ready,
    });
    const before = tree(ws);
    const mounts = mountsOf(executor.invocation("ls", ws).args);
    expect(mounts).toHaveLength(6);
    expect(mounts.join("\n")).toContain(".git/hooks");
    expect(mounts.join("\n")).not.toContain(".devcontainer");
    expect(tree(ws)).toEqual(before);
    expect(executor.describe()).toContain("read-only");
  });
});

describe("parseTerminalShell for containers", () => {
  it("reads the runtime and the image, and an image with a tag", () => {
    expect(parseTerminalShell("container")).toEqual({ kind: "container" });
    expect(parseTerminalShell("container:docker")).toEqual({
      kind: "container",
      runtime: "docker",
    });
    expect(parseTerminalShell("container:podman:node:22-slim")).toEqual({
      kind: "container",
      runtime: "podman",
      image: "node:22-slim",
    });
    expect(parseTerminalShell("Container:ubuntu:24.04")).toEqual({
      kind: "container",
      image: "ubuntu:24.04",
    });
  });

  it("is not a preference for anything else", () => {
    expect(parseTerminalShell("containers")).toBeUndefined();
    expect(parseTerminalShell("default")).toBeUndefined();
  });
});

describe("containerStatus", () => {
  const probeOf =
    (installed: boolean, answering: boolean): ContainerProbe =>
    (_r, a) =>
      a[0] === "--version" ? installed : answering;

  it("is not installed, installed but unusable, or ready", () => {
    expect(containerStatus("docker", { probe: probeOf(false, false) })).toEqual(
      { state: "not-installed", runtime: "docker" },
    );
    expect(containerStatus("docker", { probe: probeOf(true, false) })).toEqual({
      state: "installed-but-unusable",
      runtime: "docker",
    });
    expect(containerStatus("podman", { probe: probeOf(true, true) })).toEqual({
      state: "ready",
      runtime: "podman",
    });
  });

  it("only reads: a version, then an info for a daemon that is already running", () => {
    const calls: string[][] = [];
    containerStatus("docker", { probe: (_r, a) => (calls.push(a), true) });
    expect(calls).toEqual([["--version"], ["info"]]);
  });

  it("is unsupported off the three desktop platforms", () => {
    expect(
      containerStatus("docker", { platform: "freebsd" as NodeJS.Platform }),
    ).toEqual({ state: "unsupported-platform" });
  });

  it("prefers docker, then podman, then names docker", () => {
    const only =
      (runtime: string): ContainerProbe =>
      (r) =>
        r === runtime;
    expect(
      pickContainerRuntime(undefined, { probe: only("docker") }),
    ).toMatchObject({ runtime: "docker", state: "ready" });
    expect(
      pickContainerRuntime(undefined, { probe: only("podman") }),
    ).toMatchObject({ runtime: "podman", state: "ready" });
    expect(pickContainerRuntime(undefined, { probe: () => false })).toEqual({
      state: "not-installed",
      runtime: "docker",
    });
    expect(pickContainerRuntime("podman", { probe: only("docker") })).toEqual({
      state: "not-installed",
      runtime: "podman",
    });
  });
});

describe("containerUnavailableMessage", () => {
  it("says nothing when ready", () => {
    expect(containerUnavailableMessage(ready)).toBeUndefined();
  });

  it("tells a person without the runtime how to get it, and that nothing ran", () => {
    const text = containerUnavailableMessage({
      state: "not-installed",
      runtime: "docker",
    })!;
    expect(text).toContain("docs.docker.com/get-docker");
    expect(text).toContain("not run");
    expect(
      containerUnavailableMessage({
        state: "not-installed",
        runtime: "podman",
      }),
    ).toContain("podman machine");
  });

  it("says the daemon is not running, and how to start it", () => {
    const text = containerUnavailableMessage({
      state: "installed-but-unusable",
      runtime: "docker",
    })!;
    expect(text).toContain("daemon is not running");
    expect(text).toContain("Docker Desktop");
  });
});

describe("the container executor", () => {
  it("is bash in a container with its properties named, on any host", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const executor = getCommandExecutor({
        platform,
        terminalShell: { kind: "container", image: "node:22-slim" },
        containerStatus: ready,
      });
      expect(executor.kind).toBe("container");
      expect(executor.shell.kind).toBe("bash");
      expect(executor.unavailable).toBeUndefined();
      expect(executor.invocation("ls").shell).toBe("docker");
      expect(executor.describe()).toContain(
        "workspace folder only, no network",
      );
      expect(executor.describe()).toContain("node:22-slim");
    }
  });

  it("fails closed: unavailable, and never the host's shell", () => {
    const executor = getCommandExecutor({
      platform: "linux",
      env: { SHELL: "/bin/zsh" },
      terminalShell: { kind: "container", runtime: "docker" },
      containerStatus: { state: "installed-but-unusable", runtime: "docker" },
    });
    expect(executor.unavailable).toContain("daemon is not running");
    expect(executor.invocation("rm -rf x").shell).toBe("docker");
    expect(executor.invocation("rm -rf x").shell).not.toContain("zsh");
  });

  it("reads the preference from the environment, and an explicit default beats it", () => {
    const env = { CONTINUOUS_TERMINAL_SHELL: "container:podman" };
    expect(
      getCommandExecutor({
        platform: "linux",
        env,
        containerStatus: { state: "ready", runtime: "podman" },
      }).invocation("x").shell,
    ).toBe("podman");
    expect(
      getCommandExecutor({ platform: "linux", env, terminalShell: "default" })
        .kind,
    ).toBe("local");
  });

  it("gives the policy's shell reader bash through resolveShell too", () => {
    expect(
      resolveShell({ platform: "win32", terminalShell: { kind: "container" } })
        .kind,
    ).toBe("bash");
  });
});

/** A daemon answers, and the default image is already here (nothing is pulled). */
const liveDocker =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 10_000,
    windowsHide: true,
  }).status === 0 &&
  spawnSync("docker", ["image", "inspect", DEFAULT_CONTAINER_IMAGE], {
    timeout: 10_000,
    windowsHide: true,
  }).status === 0;

describe.runIf(liveDocker)(
  "a real container (docker, with the default image present)",
  () => {
    const run = (command: string, cwd: string, network = false) => {
      const executor = getCommandExecutor({
        terminalShell: { kind: "container" },
      });
      const args = network
        ? containerArgs(command, { runtime: "docker", cwd, network: "bridge" })
        : executor.invocation(command, cwd).args;
      const r = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 60_000,
        cwd,
        windowsHide: true,
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };

    it("runs a command exactly as written, with its exit code", () => {
      const heredoc = run(`cat <<'EOF'\n$HOME "x" 'y'\nEOF`, process.cwd());
      expect(heredoc).toMatchObject({ code: 0, out: `$HOME "x" 'y'\n` });
      expect(run("echo a; exit 3", process.cwd())).toMatchObject({
        code: 3,
        out: "a\n",
      });
    });

    it("has no network", () => {
      const r = run("getent hosts example.com || echo no-dns", process.cwd());
      expect(r.out).toContain("no-dns");
    });

    it("cannot write to the image, can write /tmp and the workspace", () => {
      expect(
        run("touch /usr/x 2>&1; echo $?", process.cwd())
          .out.trim()
          .endsWith("1"),
      ).toBe(true);
      expect(run("touch /tmp/x && echo ok", process.cwd()).out).toContain("ok");
      expect(run("test -w . && echo writable", process.cwd()).out).toContain(
        "writable",
      );
    });

    it("sees only the workspace: not the Docker socket, not the host home", () => {
      const r = run(
        "ls /var/run/docker.sock 2>&1; ls /root 2>&1 | head -1; echo $0",
        process.cwd(),
      );
      expect(r.out).toContain("No such file");
    });
  },
);
