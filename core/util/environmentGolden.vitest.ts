import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runTerminalCommandTool,
  withTerminalToolSentence,
} from "../tools/definitions/runTerminalCommand";
import { renderEnvironment } from "./environmentPrompt";
import {
  baseSnapshot,
  executionShellOf,
  type GatherInput,
} from "./environmentSnapshot";
import {
  describeExecutionShellParts,
  type ShellVariant,
} from "./shellDescription";

/**
 * ENV9: one scenario per platform and shell preference, through the real
 * gatherer (its synchronous half, with a fixed machine), the real renderer
 * and the real IDE terminal tool builder. The goldens are the texts each
 * surface family sends; WRITE_GOLDEN=1 rewrites them after a deliberate
 * change. A guard checks that the sentence names the shell the executor
 * reports (`executionShell().label`), so the prompt cannot describe one shell
 * while another runs the command.
 */
const GOLDEN_FILE = join(__dirname, "environmentGolden.json");

const machine = (home: string, user: string) => ({
  home,
  user,
  hostName: "golden-host",
  addresses: ["192.0.2.7"],
  arch: "x64",
  osRelease: "10.0.26100",
  timeZone: "Europe/Berlin",
  locale: "en-GB",
});
const WIN = machine("C:\\Users\\jdoe", "jdoe");
const NIX = machine("/home/jdoe", "jdoe");
const MAC = machine("/Users/jdoe", "jdoe");
const NOW = new Date(2026, 10, 12, 9, 0);

const SCENARIOS: Record<string, GatherInput> = {
  "windows-powershell": {
    platform: "win32",
    env: {},
    terminalShell: "default",
    cwd: "C:\\Users\\jdoe\\code\\acme-api",
    roots: ["file:///c%3A/Users/jdoe/code/acme-api"],
    machine: WIN,
  },
  "windows-wsl": {
    platform: "win32",
    env: {},
    terminalShell: { kind: "wsl", distro: "archlinux" },
    cwd: "C:\\Users\\jdoe\\code\\acme-api",
    roots: ["file:///c%3A/Users/jdoe/code/acme-api"],
    machine: WIN,
  },
  "linux-container": {
    platform: "linux",
    env: { SHELL: "/bin/bash" },
    terminalShell: { kind: "container", runtime: "podman", image: "node:22" },
    cwd: "/home/jdoe/acme-api",
    roots: ["file:///home/jdoe/acme-api"],
    machine: NIX,
  },
  "remote-ssh": {
    platform: "win32",
    env: {},
    remoteName: "ssh-remote",
    roots: ["vscode-remote://ssh-remote+box/home/alex/acme-api"],
    machine: WIN,
  },
  "macos-zsh": {
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    terminalShell: "default",
    cwd: "/Users/jdoe/acme-api",
    roots: ["file:///Users/jdoe/acme-api"],
    machine: MAC,
  },
  "linux-bash": {
    platform: "linux",
    env: { SHELL: "/bin/bash" },
    terminalShell: "default",
    cwd: "/home/jdoe/acme-api",
    roots: ["file:///home/jdoe/acme-api"],
    machine: NIX,
  },
};

/** The label `executionShell()` gives for each sentence variant. */
const LABEL_OF: Partial<Record<ShellVariant, (label: string) => boolean>> = {
  "powershell-5.1": (l) => l === "Windows PowerShell 5.1",
  "powershell-7": (l) => l === "PowerShell 7",
  wsl: (l) => l === "bash in WSL",
  container: (l) => l === "bash in a container",
  remote: (l) => l.startsWith("the shell of the editor's terminal ("),
  posix: (l) => ["bash", "zsh", "sh", "dash"].includes(l),
};

const sha = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

function render(name: string) {
  const input = { ...SCENARIOS[name], now: NOW };
  const snapshot = baseSnapshot(input);
  const out: Record<string, unknown> = {};
  for (const surface of ["cli", "ide-agent"] as const) {
    const d = renderEnvironment(snapshot, { surface, detail: "standard" });
    out[surface] = {
      systemLine: d.systemLine,
      toolSentence: d.toolSentence,
      firstMessageBlock: d.firstMessageBlock,
    };
  }
  const ide = renderEnvironment(snapshot, {
    surface: "ide-agent",
    detail: "standard",
  });
  const [tool] = withTerminalToolSentence(
    [runTerminalCommandTool],
    ide.toolSentence,
  );
  out.ideToolDescription = sha(tool.function.description ?? "");
  return { snapshot, input, out };
}

describe("ENV9: real-builder environment goldens per platform", () => {
  const actual: Record<string, unknown> = {};
  for (const name of Object.keys(SCENARIOS)) actual[name] = render(name).out;
  if (process.env.WRITE_GOLDEN) {
    writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + "\n");
  }
  const golden = existsSync(GOLDEN_FILE)
    ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8"))
    : {};

  for (const name of Object.keys(SCENARIOS)) {
    it(`${name} matches the golden`, () => {
      expect(actual[name]).toEqual(golden[name]);
    });

    it(`${name}: the sentence names the shell the executor reports`, () => {
      const { snapshot, input } = render(name);
      const label = executionShellOf(input).label;
      expect(snapshot.shell.shell.label).toBe(label);
      const variant = describeExecutionShellParts(snapshot.shell).variant;
      const agrees = LABEL_OF[variant];
      expect(agrees, `no label rule for variant ${variant}`).toBeDefined();
      expect(agrees!(label), `${variant} vs "${label}"`).toBe(true);
    });

    it(`${name}: no account, host or address in any text`, () => {
      const text = JSON.stringify(render(name).out);
      for (const never of ["jdoe", "golden-host", "192.0.2.7"]) {
        expect(text).not.toContain(never);
      }
    });
  }

  it("the tools and system texts are the same in two folders of one machine", () => {
    const a = baseSnapshot({ ...SCENARIOS["linux-bash"], now: NOW });
    const b = baseSnapshot({
      ...SCENARIOS["linux-bash"],
      cwd: "/srv/other",
      roots: ["file:///srv/other"],
      now: NOW,
    });
    for (const surface of ["cli", "ide-agent"] as const) {
      const x = renderEnvironment(a, { surface, detail: "standard" });
      const y = renderEnvironment(b, { surface, detail: "standard" });
      expect(y.hash).toBe(x.hash);
      expect(y.firstMessageBlock).not.toBe(x.firstMessageBlock);
    }
  });
});
