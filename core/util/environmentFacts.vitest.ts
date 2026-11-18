import { describe, expect, it } from "vitest";
import {
  containerHintOf,
  environmentFactsOf,
  isWslVersionString,
  localityOf,
  osFamilyOf,
  shellFamilyOf,
  userlandOf,
} from "./environmentFacts";

describe("osFamilyOf", () => {
  it.each([
    ["win32", "windows"],
    ["darwin", "macos"],
    ["linux", "linux"],
    ["freebsd", "other"],
  ])("%s is %s and known", (platform, family) => {
    const f = osFamilyOf(platform);
    expect(f.value).toBe(family);
    expect(f.confidence).toBe("known");
  });

  it("says unknown for nothing", () => {
    expect(osFamilyOf(undefined)).toMatchObject({
      value: "unknown",
      confidence: "unknown",
    });
    expect(osFamilyOf("").confidence).toBe("unknown");
  });
});

describe("shellFamilyOf", () => {
  it.each([
    ["/bin/zsh", "zsh"],
    ["/opt/homebrew/bin/bash", "bash"],
    ["/bin/dash", "posix"],
    ["/bin/sh", "posix"],
    ["/usr/bin/fish", "fish"],
    ["/usr/bin/nu", "nushell"],
    ["/bin/tcsh", "csh"],
    ["/usr/bin/ksh93", "ksh"],
    ["/usr/bin/xonsh", "xonsh"],
    ["/usr/local/bin/pwsh", "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", "cmd"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
  ])("%s is %s", (shell, family) => {
    expect(shellFamilyOf(shell).value).toBe(family);
  });

  it("is likely from the environment and known when we started it", () => {
    expect(shellFamilyOf("/bin/zsh").confidence).toBe("likely");
    expect(shellFamilyOf("/bin/zsh", { started: true }).confidence).toBe(
      "known",
    );
  });

  it("does not guess an unrecognised or empty shell", () => {
    expect(shellFamilyOf("/usr/bin/elvish")).toMatchObject({
      value: "unknown",
      confidence: "unknown",
    });
    expect(shellFamilyOf("  ").confidence).toBe("unknown");
    expect(shellFamilyOf(undefined).value).toBe("unknown");
  });
});

describe("localityOf", () => {
  it.each(["local", "", undefined, "na", "LOCAL"])("%s is local", (name) => {
    expect(localityOf(name).value).toBe("local");
  });

  it.each(["ssh-remote", "wsl", "dev-container", "codespaces", "ssh"])(
    "%s is remote",
    (name) => {
      const f = localityOf(name);
      expect(f.value).toBe("remote");
      expect(f.confidence).toBe("known");
    },
  );
});

describe("userlandOf", () => {
  it("macOS is BSD, but only likely", () => {
    expect(userlandOf({ platform: "darwin" })).toMatchObject({
      value: "bsd",
      confidence: "likely",
    });
  });

  it("Alpine is busybox, by release file or os-release id", () => {
    expect(userlandOf({ platform: "linux", alpineRelease: true }).value).toBe(
      "busybox",
    );
    expect(
      userlandOf({ platform: "linux", osReleaseIds: ["Alpine"] }).value,
    ).toBe("busybox");
    expect(
      userlandOf({ platform: "linux", sedLinkTarget: "/bin/busybox" }).value,
    ).toBe("busybox");
  });

  it("other Linux is GNU", () => {
    expect(
      userlandOf({ platform: "linux", osReleaseIds: ["debian", "ubuntu"] })
        .value,
    ).toBe("gnu");
  });

  it("Windows and no platform are unknown", () => {
    expect(userlandOf({ platform: "win32" }).confidence).toBe("unknown");
    expect(userlandOf({}).value).toBe("unknown");
  });
});

describe("containerHintOf", () => {
  it("no marker is unknown, never no", () => {
    const h = containerHintOf({});
    expect(h.inContainer).toMatchObject({
      value: "unknown",
      confidence: "unknown",
    });
    expect(h.markers).toEqual([]);
  });

  it("collects every marker and is at most likely", () => {
    const h = containerHintOf({
      dockerenv: true,
      codespaces: "true",
      cgroupText: "0::/system.slice/docker-abc.scope",
    });
    expect(h.inContainer).toMatchObject({ value: "yes", confidence: "likely" });
    expect(h.markers).toEqual([
      "/.dockerenv",
      "CODESPACES=true",
      "/proc/1/cgroup",
    ]);
  });

  it("ignores a CODESPACES value that is not true", () => {
    expect(containerHintOf({ codespaces: "false" }).markers).toEqual([]);
  });
});

describe("isWslVersionString", () => {
  it("the distro variable is known", () => {
    expect(isWslVersionString(undefined, "Arch")).toMatchObject({
      value: "yes",
      confidence: "known",
    });
  });

  it("reads the kernel string", () => {
    expect(
      isWslVersionString("Linux version 6.6.87.2-microsoft-standard-WSL2")
        .value,
    ).toBe("yes");
    expect(isWslVersionString("Linux version 6.8.0-generic").value).toBe("no");
  });

  it("an unread string is unknown", () => {
    expect(isWslVersionString(undefined).confidence).toBe("unknown");
  });
});

describe("environmentFactsOf", () => {
  it("a local mac with zsh", () => {
    const f = environmentFactsOf({
      platform: "darwin",
      arch: "arm64",
      shell: "/bin/zsh",
      remoteName: "local",
    });
    expect(f.os.value).toBe("macos");
    expect(f.arch).toBe("arm64");
    expect(f.shell.value).toBe("zsh");
    expect(f.userland.value).toBe("bsd");
    expect(f.locality.value).toBe("local");
  });

  it("a remote window asserts nothing about the machine", () => {
    const f = environmentFactsOf({
      platform: "win32",
      arch: "x64",
      shell: "powershell.exe",
      remoteName: "ssh-remote",
    });
    expect(f.locality.value).toBe("remote");
    expect(f.os).toMatchObject({ value: "unknown", confidence: "unknown" });
    expect(f.shell.value).toBe("unknown");
    expect(f.userland.value).toBe("unknown");
    expect(f.arch).toBeUndefined();
  });

  it("works with nothing given", () => {
    const f = environmentFactsOf({});
    expect(f.os.value).toBe("unknown");
    expect(f.shell.value).toBe("unknown");
    expect(f.locality.value).toBe("local");
    expect(f.container.inContainer.value).toBe("unknown");
  });

  it("carries the container hint through", () => {
    const f = environmentFactsOf({
      platform: "linux",
      shell: "/bin/bash",
      shellStarted: true,
      container: { containerenv: true },
      userland: { osReleaseIds: ["alpine"] },
    });
    expect(f.container.markers).toEqual(["/run/.containerenv"]);
    expect(f.userland.value).toBe("busybox");
    expect(f.shell.confidence).toBe("known");
  });
});
