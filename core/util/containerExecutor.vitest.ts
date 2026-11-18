import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { containerArgs, containerWorkdir } from "./containerArgs";
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
