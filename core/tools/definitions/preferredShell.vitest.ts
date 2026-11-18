import { describe, expect, it } from "vitest";
import { resolveShell } from "../../util/shell";
import { getPreferredShell } from "./runTerminalCommand";

describe("the tool description names the shell the executor starts", () => {
  const cases: [NodeJS.Platform, NodeJS.ProcessEnv, string][] = [
    ["win32", {}, "powershell.exe"],
    ["win32", { SHELL: "/usr/bin/bash" }, "powershell.exe"],
    ["darwin", {}, "/bin/zsh"],
    ["darwin", { SHELL: "/opt/homebrew/bin/bash" }, "/opt/homebrew/bin/bash"],
    ["linux", {}, "/bin/bash"],
    ["linux", { SHELL: "/usr/bin/fish" }, "/usr/bin/fish"],
  ];

  it.each(cases)("%s with %j: %s", (platform, env, expected) => {
    // The same text as before for every case: only resolveShell's macOS
    // default moved (from /bin/bash to /bin/zsh) to meet it
    expect(getPreferredShell({ platform, env })).toBe(expected);
    expect(
      resolveShell({ platform, env, terminalShell: "default" }).executable,
    ).toBe(expected);
  });

  it("a WSL or container preference does not change the sentence", () => {
    expect(
      getPreferredShell({
        platform: "win32",
        env: { CONTINUOUS_TERMINAL_SHELL: "wsl" },
      }),
    ).toBe("powershell.exe");
    expect(
      getPreferredShell({
        platform: "linux",
        env: {
          CONTINUOUS_TERMINAL_SHELL: "container:docker",
          SHELL: "/bin/zsh",
        },
      }),
    ).toBe("/bin/zsh");
  });
});
