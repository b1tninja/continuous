import { describe, expect, it } from "vitest";
import { executionShell, resolveShell, shellLabel } from "./shell";

const windows = { platform: "win32" as const, env: {} };
const linux = (shell: string) => ({
  platform: "linux" as const,
  env: { SHELL: shell },
});

describe("executionShell: the shell that will really read a terminal command", () => {
  it("is the shell started here in a local window, the CLI or a test", () => {
    for (const remoteName of [undefined, "", "local"]) {
      expect(executionShell(remoteName, windows)).toEqual({
        kind: "powershell",
        source: "spawned",
        label: "Windows PowerShell 5.1",
      });
      expect(executionShell(remoteName, linux("/usr/bin/zsh"))).toEqual({
        kind: "zsh",
        source: "spawned",
        label: "zsh",
      });
    }
  });

  it("is unknown in a remote window, whatever this machine's shell is", () => {
    for (const remoteName of [
      "ssh-remote",
      "wsl",
      "dev-container",
      "codespaces",
      "ssh",
    ]) {
      for (const here of [windows, linux("/bin/bash")]) {
        expect(executionShell(remoteName, here)).toEqual({
          kind: "unknown",
          source: "terminal",
          label: `the shell of the editor's terminal (${remoteName})`,
        });
      }
    }
  });

  it("says so when the login shell is one this product does not parse", () => {
    expect(executionShell("local", linux("/usr/bin/fish"))).toEqual({
      kind: "unknown",
      source: "spawned",
      label: "fish (not a shell this product parses)",
    });
  });
});

describe("shellLabel", () => {
  it("names WSL and a container by where the command runs", () => {
    expect(
      shellLabel(resolveShell({ ...windows, terminalShell: { kind: "wsl" } })),
    ).toBe("bash in WSL");
    expect(
      shellLabel(
        resolveShell({
          ...linux("/bin/bash"),
          terminalShell: { kind: "container", runtime: "podman" },
        }),
      ),
    ).toBe("bash in a container");
  });
});
