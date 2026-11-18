import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMcpPaste } from "./parseMcpPaste";
import type { McpCandidate, McpNamedValue, McpPasteFormat } from "./types";

/*
  MCPW1. The golden corpus in core/config/fixtures/mcpPaste is real README and
  documentation snippets, each with its source URL (pinned to a commit for
  GitHub) and the date it was read, in corpus.json. No network at test time.
*/

const DIR = path.join(__dirname, "..", "fixtures", "mcpPaste");

interface CorpusEntry {
  file: string;
  source: string;
  retrieved: string;
  kind: "readme" | "docs" | "false-positive" | "mixed";
  note?: string;
  expect: {
    candidates: Record<string, unknown>[];
    warningIncludes?: string | null;
  };
}

const corpus: CorpusEntry[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "corpus.json"), "utf8"),
);
const read = (file: string) => fs.readFileSync(path.join(DIR, file), "utf8");

function classOf(v: McpNamedValue) {
  if (v.reference) return "ref";
  if (v.secretLooking) return "secret";
  if (v.placeholder) return "placeholder";
  return v.value === undefined ? "none" : "literal";
}

function compact(c: McpCandidate): Record<string, unknown> {
  const o: Record<string, unknown> = {
    name: c.name,
    transport: c.transport,
    sourceFormat: c.sourceFormat,
  };
  if (c.command !== undefined) {
    o.command = c.command;
    o.args = c.args;
  }
  if (c.url !== undefined) o.url = c.url;
  if (c.env.length) {
    o.env = Object.fromEntries(c.env.map((v) => [v.name, classOf(v)]));
  }
  if (c.headers.length) {
    o.headers = Object.fromEntries(c.headers.map((v) => [v.name, classOf(v)]));
  }
  return o;
}

describe("golden corpus", () => {
  it("has at least 40 snippets, each with a source and a date", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    for (const e of corpus) {
      expect(e.source).toMatch(/^https:\/\//);
      expect(e.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fs.existsSync(path.join(DIR, e.file))).toBe(true);
    }
    // Every snippet file is listed, so none is tested without a source
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".txt"));
    expect(files.sort()).toEqual(corpus.map((e) => e.file).sort());
  });

  it("includes false positives that must yield no server", () => {
    const negatives = corpus.filter((e) => e.expect.candidates.length === 0);
    expect(negatives.length).toBeGreaterThanOrEqual(10);
  });

  it.each(corpus.map((e) => [e.file, e] as const))("%s", (_file, entry) => {
    const result = parseMcpPaste(read(entry.file));
    expect(result.candidates.map(compact)).toEqual(entry.expect.candidates);
    if (entry.expect.warningIncludes) {
      expect(
        result.warnings.some((w) => w.includes(entry.expect.warningIncludes!)),
      ).toBe(true);
    }
  });

  it("covers every paste format except a bare URL (unit-tested below)", () => {
    const seen = new Set<McpPasteFormat>();
    for (const e of corpus) {
      for (const c of parseMcpPaste(read(e.file)).candidates) {
        seen.add(c.sourceFormat);
      }
    }
    const all: McpPasteFormat[] = [
      "mcpServers-json",
      "vscode-json",
      "zed-json",
      "opencode-json",
      "server-json",
      "codex-toml",
      "command-line",
      "claude-mcp-add",
      "claude-mcp-add-json",
      "code-add-mcp",
      "cli-mcp-add",
      "vscode-link",
      "cursor-link",
    ];
    for (const f of all) expect(seen, f).toContain(f);
  });
});

describe("parseMcpPaste: shapes", () => {
  it("reads a bare https URL ending in /mcp or /sse", () => {
    const http = parseMcpPaste("https://mcp.linear.app/mcp").candidates[0];
    expect(http).toMatchObject({
      name: "linear",
      nameGuessed: true,
      transport: "http",
      transportGuessed: true,
      url: "https://mcp.linear.app/mcp",
      sourceFormat: "url",
    });
    expect(
      parseMcpPaste("https://mcp.asana.com/sse").candidates[0],
    ).toMatchObject({ transport: "sse" });
  });

  it("keeps a literal credential value, flagged, and never a reference's value", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const r = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          gh: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
            env: { GITHUB_TOKEN: token, OTHER: "${env:OTHER}", MODE: "fast" },
          },
        },
      }),
    );
    const env = Object.fromEntries(r.candidates[0].env.map((v) => [v.name, v]));
    expect(env.GITHUB_TOKEN).toMatchObject({
      value: token,
      secretLooking: true,
    });
    expect(env.OTHER).toEqual({
      name: "OTHER",
      reference: { kind: "env", name: "OTHER" },
      secretLooking: false,
      placeholder: false,
    });
    expect(env.MODE).toMatchObject({ value: "fast", secretLooking: false });
  });

  it("treats a VS Code input with password: true as a secret reference", () => {
    const r = parseMcpPaste(
      JSON.stringify({
        inputs: [{ type: "promptString", id: "tok", password: true }],
        servers: {
          s: { command: "node", args: ["s.js"], env: { X: "${input:tok}" } },
        },
      }),
    );
    expect(r.candidates[0].env[0]).toMatchObject({
      reference: { kind: "vscode-input", name: "tok" },
      secretLooking: true,
    });
  });

  it("reads JSONC: comments and trailing commas", () => {
    const r = parseMcpPaste(`{
      // my servers
      "servers": {
        "time": { "command": "uvx", "args": ["mcp-server-time",], }, /* end */
      },
    }`);
    expect(r.candidates.map((c) => c.name)).toEqual(["time"]);
  });

  it("reads Windows paths with spaces and backslashes", () => {
    const r = parseMcpPaste(
      String.raw`{"mcpServers":{"fs":{"command":"C:\\Program Files\\nodejs\\node.exe","args":["C:\\Users\\me\\My Tools\\server.js"]}}}`,
    );
    expect(r.candidates[0]).toMatchObject({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\me\\My Tools\\server.js"],
    });
    const line = parseMcpPaste(
      String.raw`node "C:\Users\me\My Tools\server.js" --root C:\work`,
    ).candidates[0];
    expect(line.args).toEqual([
      "C:\\Users\\me\\My Tools\\server.js",
      "--root",
      "C:\\work",
    ]);
  });

  it("joins PowerShell and cmd line continuations", () => {
    const ps = parseMcpPaste("npx -y `\n  @modelcontextprotocol/server-memory");
    expect(ps.candidates[0].args).toEqual([
      "-y",
      "@modelcontextprotocol/server-memory",
    ]);
    const cmd = parseMcpPaste(
      "npx -y ^\r\n  @modelcontextprotocol/server-memory",
    );
    expect(cmd.candidates[0].args).toEqual([
      "-y",
      "@modelcontextprotocol/server-memory",
    ]);
  });

  it("reads env assignments before a command", () => {
    const r = parseMcpPaste(
      "BRAVE_API_KEY=YOUR_KEY npx -y @modelcontextprotocol/server-brave-search",
    );
    expect(r.candidates[0].env[0]).toMatchObject({
      name: "BRAVE_API_KEY",
      placeholder: true,
      secretLooking: false,
    });
  });

  it("reads several servers and names each one", () => {
    const r = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          a: { command: "npx", args: ["a"] },
          b: { url: "https://x.example/mcp" },
          c: { foo: 1 },
        },
      }),
    );
    expect(r.candidates.map((c) => c.name)).toEqual(["a", "b"]);
    expect(r.warnings.join(" ")).toContain('"c" has no command or URL');
  });

  it("splits a command written as one string and says so", () => {
    const c = parseMcpPaste(
      '{"mcpServers":{"x":{"command":"npx -y pkg@1.0.0"}}}',
    ).candidates[0];
    expect(c).toMatchObject({ command: "npx", args: ["-y", "pkg@1.0.0"] });
    expect(c.warnings.join(" ")).toContain("split");
  });

  it("refuses an unsupported transport type", () => {
    const r = parseMcpPaste(
      '{"mcpServers":{"w":{"type":"ws","url":"wss://x/socket"}}}',
    );
    expect(r.candidates).toEqual([]);
  });

  it("names variables it does not fill in", () => {
    const c = parseMcpPaste(
      '{"servers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","${workspaceFolder}"]}}}',
    ).candidates[0];
    expect(c.warnings.join(" ")).toContain("${workspaceFolder}");
  });

  it("reads a BOM and CRLF line endings", () => {
    const r = parseMcpPaste(
      '\uFEFF{\r\n "mcpServers": {\r\n  "m": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]}\r\n }\r\n}\r\n',
    );
    expect(r.candidates[0].name).toBe("m");
  });
});

describe("parseMcpPaste: false positives yield no server", () => {
  const none = [
    [
      "a README sentence with npx",
      "Run npx -y @modelcontextprotocol/server-memory to start it.",
    ],
    [
      "a package.json with scripts",
      '{"name":"app","scripts":{"start":"npx tsx src/index.ts"}}',
    ],
    ["a docker web app with -p", "docker run -p 8080:80 nginx"],
    ["an http docs URL", "http://example.com/docs/getting-started"],
    ["JSON with no servers", '{"compilerOptions":{"strict":true}}'],
    [
      "a curl | sh install line",
      "curl -fsSL https://example.com/install.sh | sh",
    ],
    ["an empty paste", "   \n  "],
    ["plain prose", "This server gives the agent tools for your database."],
  ] as const;
  it.each(none)("%s", (_label, text) => {
    expect(parseMcpPaste(text).candidates).toEqual([]);
  });

  it("explains the curl | sh line", () => {
    const r = parseMcpPaste("curl -fsSL https://example.com/install.sh | bash");
    expect(r.warnings[0]).toContain("downloads a script");
  });
});

// ---------------------------------------------------------------------------
// Properties, with a seeded generator so a failure is reproducible

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PIECES = [
  "{",
  "}",
  "[",
  "]",
  '"',
  "'",
  ":",
  ",",
  "\n",
  " ",
  "\\",
  "`",
  "^",
  "|",
  "&&",
  "mcpServers",
  "servers",
  "command",
  "args",
  "url",
  "env",
  "npx",
  "-y",
  "uvx",
  "docker",
  "run",
  "-i",
  "claude",
  "mcp",
  "add",
  "--",
  "https://",
  "mcp.x.dev/mcp",
  "${input:a}",
  "${{ secrets.A }}",
  "\u202E",
  "\u200B",
  "```",
  "#",
  "...",
];

function randomPaste(next: () => number): string {
  const n = 1 + Math.floor(next() * 40);
  let s = "";
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(next() * PIECES.length)];
  return s;
}

describe("parseMcpPaste: properties", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never throws and always returns well-formed candidates (2,000 random pastes)", () => {
    const next = rng(20261112);
    for (let i = 0; i < 2000; i++) {
      const text = randomPaste(next);
      const r = parseMcpPaste(text);
      expect(Array.isArray(r.candidates)).toBe(true);
      for (const c of r.candidates) {
        expect(c.name.length).toBeGreaterThan(0);
        if (c.transport === "stdio")
          expect(c.command?.length).toBeGreaterThan(0);
        else expect(c.url?.length).toBeGreaterThan(0);
        for (const v of [...c.env, ...c.headers]) {
          if (v.reference) expect(v.value).toBeUndefined();
        }
      }
    }
  });

  it("round-trips: a candidate written back as mcpServers JSON reads the same", () => {
    for (const e of corpus) {
      for (const c of parseMcpPaste(read(e.file)).candidates) {
        const entry: Record<string, unknown> =
          c.transport === "stdio"
            ? { command: c.command, args: c.args }
            : { type: c.transport, url: c.url };
        const again = parseMcpPaste(
          JSON.stringify({ mcpServers: { [c.name]: entry } }),
        ).candidates[0];
        const pick = (x: McpCandidate) => ({
          name: x.name,
          transport: x.transport,
          command: x.command,
          args: x.args,
          url: x.url,
        });
        expect(pick(again)).toEqual(pick(c));
      }
    }
  });

  it("is deterministic", () => {
    for (const e of corpus) {
      expect(parseMcpPaste(read(e.file))).toEqual(parseMcpPaste(read(e.file)));
    }
  });

  it("never starts a process or makes a request", () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    const exec = vi.spyOn(childProcess, "exec");
    const execFile = vi.spyOn(childProcess, "execFile");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const e of corpus) parseMcpPaste(read(e.file));
    const next = rng(7);
    for (let i = 0; i < 300; i++) parseMcpPaste(randomPaste(next));
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("caps a huge paste and says so", () => {
    const r = parseMcpPaste("x".repeat(250_000));
    expect(r.warnings[0]).toContain("first 200000 characters");
  });
});
