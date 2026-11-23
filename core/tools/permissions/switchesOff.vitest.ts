import { describe, expect, it } from "vitest";
import { testToolCall } from "./testToolCall";
import { BUILTIN_RULES, type PolicyLevel } from "./policy";

/**
 * With every built-in safety check switched off, a call that only a check
 * would stop must get the same decision as the harmless call next to it. Each
 * pair differs in exactly the thing a check looks at, so a pair that differs
 * means a check still runs after its switch is off.
 */

const ALL_OFF = Object.fromEntries(
  BUILTIN_RULES.map((r) => [r.id, false]),
) as Record<string, boolean>;

interface Pair {
  name: string;
  risky: { tool: string; args: Record<string, unknown> };
  benign: { tool: string; args: Record<string, unknown> };
  trusted?: string[];
  benignTrusted?: string[];
}

const PAIRS: Pair[] = [
  {
    name: "read a secret file",
    risky: { tool: "read_file", args: { filepath: ".env" } },
    benign: { tool: "read_file", args: { filepath: "README.md" } },
  },
  {
    name: "command that names a secret file",
    risky: { tool: "run_terminal_command", args: { command: "cat .env" } },
    benign: {
      tool: "run_terminal_command",
      args: { command: "cat README.md" },
    },
  },
  {
    name: "command that prints the environment",
    risky: { tool: "run_terminal_command", args: { command: "printenv" } },
    benign: { tool: "run_terminal_command", args: { command: "pwd" } },
  },
  {
    name: "edit a config file",
    risky: {
      tool: "edit_existing_file",
      args: { filepath: ".git/config", changes: "x" },
    },
    benign: {
      tool: "edit_existing_file",
      args: { filepath: "src/a.ts", changes: "x" },
    },
  },
  {
    name: "edit a file outside the workspace",
    risky: {
      tool: "edit_existing_file",
      args: { filepath: "/home/other/notes.md", changes: "x" },
    },
    benign: {
      tool: "edit_existing_file",
      args: { filepath: "src/a.ts", changes: "x" },
    },
  },
  {
    name: "read a file outside the workspace",
    risky: { tool: "read_file", args: { filepath: "/home/other/notes.md" } },
    benign: { tool: "read_file", args: { filepath: "src/a.ts" } },
  },
  {
    name: "recursive delete",
    risky: { tool: "run_terminal_command", args: { command: "rm -rf build" } },
    benign: { tool: "run_terminal_command", args: { command: "ls build" } },
  },
  {
    name: "history rewrite",
    risky: {
      tool: "run_terminal_command",
      args: { command: "git push --force origin main" },
    },
    benign: { tool: "run_terminal_command", args: { command: "git status" } },
  },
  {
    name: "dependency install",
    risky: {
      tool: "run_terminal_command",
      args: { command: "npm install left-pad" },
    },
    benign: { tool: "run_terminal_command", args: { command: "npm test" } },
  },
  {
    name: "manifest edit",
    risky: {
      tool: "edit_existing_file",
      args: { filepath: "package.json", changes: "x" },
    },
    benign: {
      tool: "edit_existing_file",
      args: { filepath: "src/a.ts", changes: "x" },
    },
  },
  {
    name: "large change",
    risky: {
      tool: "create_new_file",
      args: {
        filepath: "src/big.ts",
        contents: Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"),
      },
    },
    benign: {
      tool: "create_new_file",
      args: { filepath: "src/big.ts", contents: "one line" },
    },
  },
  {
    // The same host with no trusted-domain list is the harmless pair: the
    // unknown-host check cannot apply without a list, so only the level decides.
    name: "fetch from a host outside trusted domains",
    risky: {
      tool: "fetch_url_content",
      args: { url: "https://unknown.example.net/page" },
    },
    benign: {
      tool: "fetch_url_content",
      args: { url: "https://unknown.example.net/page" },
    },
    trusted: ["example.org"],
    benignTrusted: [],
  },
];

const LEVELS: PolicyLevel[] = ["permissive", "automatic"];

function decide(
  call: { tool: string; args: Record<string, unknown> },
  level: PolicyLevel,
  trusted: string[] | undefined,
) {
  return testToolCall({
    tool: call.tool,
    args: call.args,
    levels: {
      context: level,
      tools: level,
      edits: level,
      plan: level,
      questions: level,
    },
    sources: {
      user: { auto: { environment: { trustedDomains: trusted ?? [] } } },
      builtin: ALL_OFF,
    },
    cwd: "/home/dev/shop",
    shell: "bash",
  });
}

describe("with every built-in safety check switched off", () => {
  it("lists every built-in rule, so the test covers them all", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0);
  });

  for (const level of LEVELS) {
    for (const pair of PAIRS) {
      it(`${pair.name} is decided like its harmless pair (${level})`, () => {
        const risky = decide(pair.risky, level, pair.trusted);
        const benign = decide(
          pair.benign,
          level,
          pair.benignTrusted ?? pair.trusted,
        );
        expect(risky.decision).toBe(benign.decision);
      });
    }
  }
});
