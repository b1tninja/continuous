import { afterEach, describe, expect, it } from "vitest";

import {
  runTerminalCommandTool,
  withTerminalToolSentence,
} from "../tools/definitions/runTerminalCommand";
import {
  placeEnvironment,
  withLeadingText,
  withTrailingText,
} from "./environmentMessages";
import { editorSessionEnvironment } from "./environmentSession";
import {
  getTerminalShellPreference,
  resolveShell,
  setSessionTerminalShell,
  setTerminalShellPreference,
} from "./shell";

const machine = {
  home: "/home/zzcanaryuser",
  user: "zzcanaryuser",
  hostName: "box-1234",
  addresses: [],
  arch: "x64",
  osRelease: "6.8.0",
  timeZone: undefined,
  locale: undefined,
};

afterEach(() => {
  setSessionTerminalShell(undefined);
  setTerminalShellPreference(undefined);
});

describe("editorSessionEnvironment (ENV13, ENV14)", () => {
  it("gathers a new session once and freezes the executor at its shell", async () => {
    setTerminalShellPreference({ kind: "container", image: "node:22" });
    const env = await editorSessionEnvironment({
      workspaceDirs: async () => ["file:///home/zzcanaryuser/acme-api"],
      gather: { platform: "linux", env: {}, machine, skipGit: true },
    });
    expect(env.detail).toBe("standard");
    expect(env.snapshot.shell.container?.image).toBe("node:22");
    expect(env.strings?.toolSentence).toContain("container");
    expect(env.strings?.firstMessageBlock).toContain("~/acme-api");
    expect(JSON.stringify(env.strings)).not.toContain("zzcanaryuser");
    // The setting changes mid-session: the executor keeps the session's shell
    setTerminalShellPreference(undefined);
    expect(getTerminalShellPreference({})).toEqual({
      kind: "container",
      image: "node:22",
    });
    expect(resolveShell({ platform: "linux", env: {} }).executable).toBe(
      "docker",
    );
  });

  it("a saved session is frozen at its own shell and keeps its texts", async () => {
    const first = await editorSessionEnvironment({
      workspaceDirs: async () => [],
      gather: {
        platform: "win32",
        env: {},
        machine,
        skipGit: true,
        terminalShell: { kind: "wsl", distro: "archlinux" },
      },
    });
    setSessionTerminalShell(undefined);
    const resumed = await editorSessionEnvironment({
      saved: first,
      workspaceDirs: async () => {
        throw new Error("a saved session is not regathered");
      },
    });
    expect(resumed).toBe(first);
    expect(getTerminalShellPreference({})).toEqual({
      kind: "wsl",
      distro: "archlinux",
    });
  });

  it("a new session reads the setting, not the shell an earlier session froze", async () => {
    setSessionTerminalShell({ kind: "wsl" });
    setTerminalShellPreference(undefined);
    const env = await editorSessionEnvironment({
      workspaceDirs: async () => [],
      gather: { platform: "win32", env: {}, machine, skipGit: true },
    });
    expect(env.snapshot.shell.wsl).toBeUndefined();
    expect(env.strings?.toolSentence).toContain("Windows PowerShell 5.1");
    expect(getTerminalShellPreference({})).toBeUndefined();
  });
});

describe("the terminal tool's shell sentence", () => {
  it("names no folder and replaces only the terminal tool's text", () => {
    expect(runTerminalCommandTool.function.description).not.toContain(
      "Choose terminal commands",
    );
    expect(runTerminalCommandTool.function.description).not.toContain(
      process.cwd(),
    );
    const other = {
      function: { name: "read_file", description: "Reads." },
    };
    const [terminal, read] = withTerminalToolSentence(
      [runTerminalCommandTool, other],
      "Runs in TESTSHELL.",
    );
    expect(terminal.function.description).toMatch(/Runs in TESTSHELL\.$/);
    expect(
      (terminal as typeof runTerminalCommandTool).systemMessageDescription
        ?.prefix,
    ).toContain("Runs in TESTSHELL.");
    expect(read).toBe(other);
  });
});

describe("placing the texts in messages", () => {
  const msgs: Array<{ role: string; content: unknown }> = [
    { role: "system", content: "s" },
    { role: "user", content: "one" },
    { role: "assistant", content: "a" },
    { role: "user", content: [{ type: "text", text: "two" }] },
  ];
  const isUser = (m: { role: string }) => m.role === "user";

  it("the first block goes on the first user message, notices on theirs", () => {
    const out = placeEnvironment(
      msgs,
      isUser,
      (m, add) => ({
        ...m,
        content: withTrailingText(
          withLeadingText(m.content, add.first ?? ""),
          add.notices.join("\n\n"),
        ),
      }),
      "BLOCK",
      [{ userTurn: 1, localDay: "2026-11-13", text: "NOTICE" }],
    );
    expect(out[1].content).toBe("BLOCK\n\none");
    expect(out[3].content).toEqual([
      { type: "text", text: "two" },
      { type: "text", text: "NOTICE" },
    ]);
    expect(out[0]).toBe(msgs[0]);
    expect(msgs[1].content).toBe("one");
  });
});
