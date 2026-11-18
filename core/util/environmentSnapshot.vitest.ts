import { describe, expect, it } from "vitest";

import { renderEnvironment } from "./environmentPrompt";
import {
  baseSnapshot,
  executionShellOf,
  frozenTerminalShell,
  gatherEnvironment,
  isEnvironmentSnapshot,
  localDayOf,
  localFolderOf,
  parseEnvDetail,
  type GatherInput,
} from "./environmentSnapshot";
import { secretCases } from "./secretScan/fixtures";

// Assembled by the fixtures, so no token-shaped literal sits in this file
const PAT = secretCases().find((c) => c.ruleId === "github-pat")!.value;

const MACHINE = {
  home: "C:\\Users\\zzcanaryuser",
  user: "zzcanaryuser",
  hostName: "build-host-77",
  addresses: ["10.20.30.40"],
  arch: "x64",
  osRelease: "10.0.26100",
  timeZone: "Europe/Berlin",
  locale: "de-DE",
};

const WIN: GatherInput = {
  platform: "win32",
  env: {},
  terminalShell: "default",
  cwd: "C:\\Users\\zzcanaryuser\\code\\acme-api",
  machine: MACHINE,
  now: new Date(2026, 10, 12, 9, 30),
};

/** A fake git: answers by the first two arguments, records calls. */
function fakeGit(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const git = async (args: string[], cwd: string) => {
    calls.push(`${cwd}: ${args.join(" ")}`);
    const a = answers[args.slice(0, 2).join(" ")];
    if (a === undefined) throw new Error(`no answer for ${args.join(" ")}`);
    if (a instanceof Error) throw a;
    return a;
  };
  return { git, calls };
}

const REPO = {
  "rev-parse --is-inside-work-tree": "true\n",
  "branch --show-current": "feature/login\n",
  "status --porcelain": " M src/app.ts\0?? notes/todo.md\0",
  "remote get-url": `https://${PAT}@github.com/acme/api.git\n`,
  "config user.name": "Alex Example\n",
  "config user.email": "alex@example.com\n",
};

describe("gatherEnvironment (ENV6)", () => {
  it("reads git once with -z and fills the never-send list", async () => {
    const { git, calls } = fakeGit(REPO);
    const s = await gatherEnvironment({ ...WIN, git });
    expect(calls).toContain(`${WIN.cwd}: status --porcelain -z`);
    expect(s.git).toEqual({
      isRepo: true,
      branch: "feature/login",
      statusZ: " M src/app.ts\0?? notes/todo.md\0",
      remoteUrl: REPO["remote get-url"].trim(),
    });
    expect(s.neverSend).toEqual({
      hostName: "build-host-77",
      addresses: ["10.20.30.40"],
      gitUserName: "Alex Example",
      gitUserEmail: "alex@example.com",
    });
    expect(s.localDay).toBe("2026-11-12");
    expect(s.shell.shell.label).toBe("Windows PowerShell 5.1");
    expect(isEnvironmentSnapshot(s)).toBe(true);
  });

  it("the rendered block carries the masked folder and none of the never-send values", async () => {
    const { git } = fakeGit(REPO);
    const s = await gatherEnvironment({ ...WIN, git });
    const d = renderEnvironment(s, { surface: "cli", detail: "full" });
    const all = [d.systemLine, d.toolSentence, d.firstMessageBlock].join("\n");
    for (const never of [
      "zzcanaryuser",
      "build-host-77",
      "10.20.30.40",
      "Alex Example",
      "alex@example.com",
      PAT,
    ]) {
      expect(all).not.toContain(never);
    }
    expect(d.firstMessageBlock).toContain(" M src/app.ts\n?? notes/todo.md");
  });

  it("a folder that is not a repository says so and reads no more", async () => {
    const { git, calls } = fakeGit({
      "rev-parse --is-inside-work-tree": new Error("not a git repository"),
    });
    const s = await gatherEnvironment({ ...WIN, git });
    expect(s.git).toEqual({ isRepo: false });
    expect(calls).toHaveLength(1);
  });

  it("a status call that times out is recorded, not thrown", async () => {
    const slow = Object.assign(new Error("timed out"), { killed: true });
    const { git } = fakeGit({ ...REPO, "status --porcelain": slow });
    const s = await gatherEnvironment({ ...WIN, git });
    expect(s.git?.statusTimedOut).toBe(true);
    expect(s.git?.statusZ).toBeUndefined();
    expect(
      renderEnvironment(s, { surface: "cli", detail: "standard" })
        .firstMessageBlock,
    ).toContain("not read (git took too long)");
  });

  it("the real git runner stops after the time limit", async () => {
    const started = Date.now();
    const s = await gatherEnvironment({
      ...WIN,
      cwd: process.cwd(),
      timeoutMs: 1,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s.git).toBeDefined();
  });

  it("a remote window reads no local git", async () => {
    const { git, calls } = fakeGit(REPO);
    const s = await gatherEnvironment({
      ...WIN,
      remoteName: "ssh-remote",
      roots: ["vscode-remote://ssh-remote+box/home/alex/acme-api"],
      cwd: undefined,
      git,
    });
    expect(calls).toHaveLength(0);
    expect(s.git).toBeUndefined();
    expect(s.shell.shell).toEqual({
      kind: "unknown",
      source: "terminal",
      label: "the shell of the editor's terminal (ssh-remote)",
    });
  });

  it("git runs in the first local workspace folder of an editor", async () => {
    const { git, calls } = fakeGit(REPO);
    await gatherEnvironment({
      ...WIN,
      cwd: undefined,
      roots: ["file:///c%3A/code/acme-api"],
      git,
    });
    expect(calls[0]).toBe("c:/code/acme-api: rev-parse --is-inside-work-tree");
  });
});

describe("the shell half", () => {
  it("names the shell the executor starts, never a label it reads", () => {
    expect(executionShellOf({ platform: "win32", env: {} })).toEqual({
      kind: "powershell",
      source: "spawned",
      label: "Windows PowerShell 5.1",
    });
    expect(
      executionShellOf({
        platform: "win32",
        env: {},
        terminalShell: { kind: "wsl", distro: "archlinux" },
      }),
    ).toEqual({ kind: "bash", source: "spawned", label: "bash in WSL" });
    expect(
      executionShellOf({
        platform: "linux",
        env: {},
        terminalShell: { kind: "container" },
      }).label,
    ).toBe("bash in a container");
    expect(
      executionShellOf({ platform: "darwin", env: { SHELL: "/bin/zsh" } }),
    ).toEqual({ kind: "zsh", source: "spawned", label: "zsh" });
    expect(executionShellOf({ remoteName: "local" }).source).toBe("spawned");
  });

  it("the base snapshot renders the same S0 and S1 bytes as the gathered one", async () => {
    const { git } = fakeGit(REPO);
    const full = await gatherEnvironment({ ...WIN, git });
    const base = baseSnapshot(WIN);
    for (const surface of ["cli", "ide-agent"] as const) {
      const a = renderEnvironment(full, { surface, detail: "standard" });
      const b = renderEnvironment(base, { surface, detail: "standard" });
      expect(b.systemLine).toBe(a.systemLine);
      expect(b.toolSentence).toBe(a.toolSentence);
      expect(b.hash).toBe(a.hash);
    }
  });

  it("freezes the executor the snapshot names (ENV13)", () => {
    const wsl = baseSnapshot({
      ...WIN,
      terminalShell: { kind: "wsl", distro: "archlinux" },
    });
    expect(frozenTerminalShell(wsl)).toEqual({
      kind: "wsl",
      distro: "archlinux",
    });
    const box = baseSnapshot({
      ...WIN,
      terminalShell: { kind: "container", runtime: "podman", image: "node:22" },
    });
    expect(frozenTerminalShell(box)).toEqual({
      kind: "container",
      runtime: "podman",
      image: "node:22",
    });
    expect(frozenTerminalShell(baseSnapshot(WIN))).toBe("default");
  });
});

describe("helpers", () => {
  it("localDayOf is the local day, not the UTC one", () => {
    expect(localDayOf(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02");
    expect(localDayOf(new Date(2026, 11, 31, 23, 55))).toBe("2026-12-31");
  });

  it("parseEnvDetail accepts the three levels only", () => {
    expect(parseEnvDetail("FULL")).toBe("full");
    expect(parseEnvDetail(" minimal ")).toBe("minimal");
    expect(parseEnvDetail("everything")).toBeUndefined();
    expect(parseEnvDetail(3)).toBeUndefined();
  });

  it("localFolderOf reads file URIs and refuses other schemes", () => {
    expect(localFolderOf("/home/a/p")).toBe("/home/a/p");
    expect(localFolderOf("file:///home/a/my%20p")).toBe("/home/a/my p");
    expect(localFolderOf("file:///C:/code/x")).toBe("C:/code/x");
    expect(localFolderOf("vscode-remote://ssh-remote+h/p")).toBeUndefined();
  });

  it("isEnvironmentSnapshot refuses other shapes", () => {
    expect(isEnvironmentSnapshot(undefined)).toBe(false);
    expect(isEnvironmentSnapshot({ version: 2 })).toBe(false);
    expect(isEnvironmentSnapshot(baseSnapshot(WIN))).toBe(true);
  });
});
