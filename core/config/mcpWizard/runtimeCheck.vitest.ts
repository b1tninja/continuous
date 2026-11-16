import { describe, expect, it } from "vitest";

import {
  checkRuntime,
  RUNTIME_LINKS,
  runtimeProgramName,
  WINDOWS_QUOTING_HINT,
} from "./runtimeCheck";

/*
  MCPW10 with fake PATHs: `isFile` answers from a set, so nothing on this
  machine is looked at and nothing is started.
*/

/**
 * Answers from a list, whatever the host's own path rules: the lookup
 * resolves with the host's `path`, so a Windows path is compared by its end,
 * with either separator and in any case (Windows file names are not
 * case-sensitive, and PATHEXT is upper case).
 */
function fakeFs(files: string[]) {
  const norm = (f: string) => f.replace(/\\/g, "/").toLowerCase();
  const want = files.map(norm);
  return (file: string) => want.some((w) => norm(file).endsWith(w));
}

const posix = (files: string[], PATH = "/usr/bin:/opt/node/bin") => ({
  platform: "linux" as const,
  env: { PATH },
  isFile: fakeFs(files),
});

const win = (files: string[], Path = "C:\\node;C:\\uv") => ({
  platform: "win32" as const,
  env: { Path, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
  isFile: fakeFs(files),
});

describe("checkRuntime on a POSIX PATH", () => {
  it("finds Node.js when npx and node are both there", () => {
    const r = checkRuntime(
      "npx",
      ["-y", "pkg@1.0.0"],
      posix(["/opt/node/bin/npx", "/opt/node/bin/node"]),
    );
    expect(r).toMatchObject({
      kind: "node",
      label: "Node.js",
      found: true,
      missing: [],
      line: "Node.js found.",
      link: RUNTIME_LINKS.node,
    });
  });

  it("names node when only npx is there", () => {
    const r = checkRuntime("npx", [], posix(["/opt/node/bin/npx"]));
    expect(r.found).toBe(false);
    expect(r.missing).toEqual(["node"]);
    expect(r.line).toBe(
      "Node.js was not found (`node` is missing). Install it, then restart your editor so the PATH is refreshed.",
    );
  });

  it("says Node.js is missing when nothing is there, and gives a link, never an install", () => {
    const r = checkRuntime("npx", [], posix([]));
    expect(r.found).toBe(false);
    expect(r.line).toMatch(/^Node\.js was not found\. Install it/);
    expect(r.link).toBe(RUNTIME_LINKS.node);
  });

  it("finds uv for uvx", () => {
    expect(checkRuntime("uvx", [], posix(["/usr/bin/uvx"]))).toMatchObject({
      kind: "uv",
      found: true,
      line: "uv found.",
    });
    expect(checkRuntime("uvx", [], posix([]))).toMatchObject({
      kind: "uv",
      found: false,
      link: RUNTIME_LINKS.uv,
    });
  });

  it("finds docker, and says the app must be running", () => {
    const r = checkRuntime(
      "docker",
      ["run", "-i", "img:1.0.0"],
      posix(["/usr/bin/docker"]),
    );
    expect(r.found).toBe(true);
    expect(r.line).toMatch(/Docker app must be running/);
    expect(checkRuntime("docker", [], posix([])).link).toBe(
      RUNTIME_LINKS.docker,
    );
  });

  it("finds Bun for bunx only when bun is there too", () => {
    expect(checkRuntime("bunx", [], posix(["/usr/bin/bunx"])).missing).toEqual([
      "bun",
    ]);
    expect(
      checkRuntime("bunx", [], posix(["/usr/bin/bunx", "/usr/bin/bun"])).found,
    ).toBe(true);
  });

  it("checks a command given as a path as a file", () => {
    expect(
      checkRuntime("/srv/bin/my-server", [], posix(["/srv/bin/my-server"]))
        .found,
    ).toBe(true);
    const r = checkRuntime("/srv/bin/gone", [], posix([]));
    expect(r).toMatchObject({ kind: "other", found: false });
    expect(r.line).toMatch(/was not found on the PATH your editor uses/);
  });

  it("does not look in folders that are not on the PATH", () => {
    expect(checkRuntime("node", [], posix(["/elsewhere/node"])).found).toBe(
      false,
    );
  });

  it("never adds the Windows hint off Windows", () => {
    expect(
      checkRuntime("npx", ["a b"], posix([])).windowsQuotingHint,
    ).toBeUndefined();
  });
});

describe("checkRuntime on a Windows PATH", () => {
  it("uses PATHEXT, so npx.cmd and node.exe are found", () => {
    const r = checkRuntime(
      "npx",
      [],
      win(["C:\\node\\npx.cmd", "C:\\node\\node.exe"]),
    );
    expect(r.found).toBe(true);
  });

  it("reads the Path variable in any case", () => {
    const r = checkRuntime("uvx", [], {
      platform: "win32",
      env: { PATH: "C:\\uv", PATHEXT: ".EXE" },
      isFile: fakeFs(["C:\\uv\\uvx.exe"]),
    });
    expect(r.found).toBe(true);
  });

  it("strips .exe and .cmd from the program name", () => {
    expect(runtimeProgramName("C:\\node\\NPX.CMD")).toBe("npx");
    expect(runtimeProgramName("/usr/bin/uvx")).toBe("uvx");
  });

  it("adds the quoting hint for npx or uvx with an argument holding a space or a quote", () => {
    const files = ["C:\\node\\npx.cmd", "C:\\node\\node.exe"];
    expect(
      checkRuntime("npx", ["-y", "pkg@1.0.0", "C:\\My Files"], win(files))
        .windowsQuotingHint,
    ).toBe(WINDOWS_QUOTING_HINT);
    expect(checkRuntime("uvx", ['say "hi"'], win([])).windowsQuotingHint).toBe(
      WINDOWS_QUOTING_HINT,
    );
    expect(
      checkRuntime("npx", ["-y", "pkg@1.0.0"], win(files)).windowsQuotingHint,
    ).toBeUndefined();
    // A program started directly gets its arguments as they are
    expect(
      checkRuntime("node", ["C:\\My Files\\s.js"], win(files))
        .windowsQuotingHint,
    ).toBeUndefined();
  });
});
