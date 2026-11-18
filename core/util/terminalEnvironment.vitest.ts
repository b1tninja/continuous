import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTerminalEnvironmentMode,
  setTerminalEnvironmentSettings,
  TERMINAL_ENV_NOTICE,
  terminalEnvironment,
  withPagerDefaults,
  withWslEnvNames,
} from "./terminalEnvironment";

const posix = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  LANG: "en_US.UTF-8",
  TERM: "xterm",
  TMPDIR: "/tmp",
  WSLENV: "FOO/p",
  EDITOR: "vim",
  ANTHROPIC_API_KEY: "sk-ant",
  AWS_SECRET_ACCESS_KEY: "aws",
  GITHUB_TOKEN: "ghp",
};

const windows = {
  Path: "C:\Windows",
  USERPROFILE: "C:\Users\me",
  TEMP: "C:\Temp",
  SystemRoot: "C:\Windows",
  ComSpec: "C:\Windows\System32\cmd.exe",
  PATHEXT: ".EXE;.CMD",
  LANG: "en_US",
  OPENAI_API_KEY: "sk",
  azure_client_secret: "s",
};

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  vi.unstubAllEnvs();
});

describe("terminalEnvironment", () => {
  it("scrubs by default and keeps the basics", () => {
    const env = terminalEnvironment(posix, { platform: "linux" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      TMPDIR: "/tmp",
      WSLENV: "FOO/p",
      EDITOR: "vim",
    });
  });

  it("keeps the Windows basics and matches secret names case-insensitively", () => {
    const env = terminalEnvironment(windows, { platform: "win32" });
    expect(Object.keys(env).sort()).toEqual(
      [
        "ComSpec",
        "LANG",
        "PATHEXT",
        "Path",
        "SystemRoot",
        "TEMP",
        "USERPROFILE",
      ].sort(),
    );
  });

  it("inherit is a copy of the base, byte for byte", () => {
    setTerminalEnvironmentSettings({ environment: "inherit" });
    const env = terminalEnvironment({ ...posix, UNSET: undefined });
    expect(env).toEqual(posix);
  });

  it("passEnv keeps an exact name that would be removed", () => {
    setTerminalEnvironmentSettings({ passEnv: ["GITHUB_TOKEN"] });
    const env = terminalEnvironment(posix, { platform: "linux" });
    expect(env.GITHUB_TOKEN).toBe("ghp");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("allowlist keeps the basics, WSL names and allow entries only", () => {
    setTerminalEnvironmentSettings({
      environment: "allowlist",
      allow: ["EDITOR"],
    });
    const env = terminalEnvironment(
      { ...posix, RANDOM_THING: "x" },
      { platform: "linux" },
    );
    expect(Object.keys(env).sort()).toEqual(
      ["EDITOR", "HOME", "LANG", "PATH", "TERM", "TMPDIR", "WSLENV"].sort(),
    );
  });

  it("CONTINUE_TERMINAL_ENV overrides config.yaml", () => {
    setTerminalEnvironmentSettings({ environment: "inherit" });
    vi.stubEnv("CONTINUE_TERMINAL_ENV", "scrub");
    expect(getTerminalEnvironmentMode()).toBe("scrub");
    vi.stubEnv("CONTINUE_TERMINAL_ENV", "allowlist");
    expect(getTerminalEnvironmentMode()).toBe("allowlist");
    vi.stubEnv("CONTINUE_TERMINAL_ENV", "bogus");
    expect(getTerminalEnvironmentMode()).toBe("inherit");
  });

  it("the tool notice is one static sentence naming passEnv", () => {
    expect(TERMINAL_ENV_NOTICE).toContain("terminal.passEnv");
  });
});

describe("withPagerDefaults", () => {
  const pagers = (env: Record<string, string>) => ({
    PAGER: env.PAGER,
    GIT_PAGER: env.GIT_PAGER,
    MANPAGER: env.MANPAGER,
    LESS: env.LESS,
  });

  it("gives a command pagers that print and end", () => {
    const env = withPagerDefaults({ PATH: "/usr/bin" }, { platform: "linux" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      PAGER: "cat",
      GIT_PAGER: "cat",
      MANPAGER: "cat",
      LESS: "FRX",
    });
  });

  it("replaces the host's pager, which has no terminal to page in, but keeps its LESS flags", () => {
    const env = withPagerDefaults(
      { PAGER: "less", GIT_PAGER: "delta", MANPAGER: "most", LESS: "-R" },
      { platform: "linux" },
    );
    expect(pagers(env)).toEqual({
      PAGER: "cat",
      GIT_PAGER: "cat",
      MANPAGER: "cat",
      LESS: "-R",
    });
  });

  it("never touches a name the person put in terminal.passEnv, set or not", () => {
    setTerminalEnvironmentSettings({ passEnv: ["GIT_PAGER", "MANPAGER"] });
    const env = withPagerDefaults(
      { PAGER: "less", GIT_PAGER: "delta" },
      { platform: "linux" },
    );
    expect(pagers(env)).toEqual({
      PAGER: "cat",
      GIT_PAGER: "delta",
      MANPAGER: undefined,
      LESS: "FRX",
    });
  });

  it("inherit keeps what the host sets and fills in the rest", () => {
    setTerminalEnvironmentSettings({ environment: "inherit" });
    const env = withPagerDefaults({ PAGER: "less" }, { platform: "linux" });
    expect(pagers(env)).toEqual({
      PAGER: "less",
      GIT_PAGER: "cat",
      MANPAGER: "cat",
      LESS: "FRX",
    });
  });

  it("compares names without case on Windows and leaves one spelling", () => {
    setTerminalEnvironmentSettings({ passEnv: ["git_pager"] });
    const env = withPagerDefaults(
      { Pager: "more", Git_Pager: "delta" },
      { platform: "win32" },
    );
    expect(env.Pager).toBeUndefined();
    expect(env.PAGER).toBe("cat");
    expect(env.Git_Pager).toBe("delta");
    expect(env.GIT_PAGER).toBeUndefined();
  });

  it("does not change its input", () => {
    const input = { PAGER: "less" };
    withPagerDefaults(input, { platform: "linux" });
    expect(input).toEqual({ PAGER: "less" });
  });
});

describe("withWslEnvNames", () => {
  it("adds a passed name with /u after what WSLENV already lists", () => {
    const env = withWslEnvNames(
      { WSLENV: "FOO/p", MY_TOKEN: "v", Path: "C:\\Windows" },
      ["MY_TOKEN"],
    );
    expect(env.WSLENV).toBe("FOO/p:MY_TOKEN/u");
    expect(env.MY_TOKEN).toBe("v");
  });

  it("creates WSLENV when there is none", () => {
    expect(withWslEnvNames({ A: "1" }, ["A"]).WSLENV).toBe("A/u");
  });

  it("keeps a name WSLENV lists already, with its own flags, and the host's spelling of WSLENV", () => {
    const env = withWslEnvNames({ WslEnv: "my_token/p", MY_TOKEN: "v" }, [
      "MY_TOKEN",
    ]);
    expect(env).toEqual({ WslEnv: "my_token/p", MY_TOKEN: "v" });
  });

  it("leaves out a name that is not set, a withheld name, WSLENV and names that would break the list", () => {
    const env = withWslEnvNames(
      { WSLENV: "", PASSED: "1", "BAD:NAME": "x", WITHHELD_KEY: "s" },
      ["PASSED", "NOT_SET", "WSLENV", "BAD:NAME", "a/b"],
    );
    expect(env.WSLENV).toBe("PASSED/u");
    expect(env.WSLENV).not.toContain("WITHHELD_KEY");
  });

  it("never puts a value in WSLENV", () => {
    const env = withWslEnvNames({ SECRET_NAME: "sk-value" }, ["SECRET_NAME"]);
    expect(env.WSLENV).not.toContain("sk-value");
  });

  it("does not change its input", () => {
    const input = { WSLENV: "X/p", A: "1" };
    withWslEnvNames(input, ["A"]);
    expect(input).toEqual({ WSLENV: "X/p", A: "1" });
  });
});
