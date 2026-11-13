import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { MockRevisionServer } from "../../context/mcp/mockMcpRevisionServer";
import { MockOAuthMcpServer } from "../../context/mcp/mockOAuthMcpServer";

import { failureHints, probeMcpServer } from "./probeMcpServer";
import type { McpServerDraft } from "./types";

// The real launch path asks the login shell for PATH on macOS and Linux;
// keep the test hermetic
vi.mock("../../util/shellPath", () => ({
  getEnvPathFromUserShell: vi.fn().mockResolvedValue(undefined),
}));

/*
  MCPW3, against the repository's own mock servers only: a stdio server
  written for these tests (context/mcp/mockStdioMcpServer.mjs) and the HTTP
  mocks the OAuth and revision tests use. No third-party package runs.
*/

const MOCK = path.join(
  __dirname,
  "..",
  "..",
  "context",
  "mcp",
  "mockStdioMcpServer.mjs",
);
const SECRET = "sk-ant-api03-" + "Q".repeat(40);

// core's Vitest setup swaps fetch for node-fetch's; the SDK wants the
// native one (same pattern as mcpRevision.vitest.ts)
const nativeGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
};
let setupGlobals: typeof nativeGlobals;
beforeAll(() => {
  setupGlobals = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    Response: globalThis.Response,
  };
  Object.assign(globalThis, nativeGlobals);
});
afterAll(() => {
  Object.assign(globalThis, setupGlobals);
});

let dir: string;
let recordFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpw-probe-"));
  recordFile = path.join(dir, "record.jsonl");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MCPW_PROBE_CANARY;
});

function mock(
  mode: string,
  extraEnv: Record<string, string> = {},
): McpServerDraft {
  return {
    name: "mock",
    transport: "stdio",
    command: process.execPath,
    args: [MOCK],
    env: [
      { name: "MOCK_MCP_MODE", value: mode, secret: false },
      { name: "MOCK_MCP_RECORD", value: recordFile, secret: false },
      ...Object.entries(extraEnv).map(([name, value]) => ({
        name,
        value,
        secret: name === "MOCK_MCP_SECRET",
      })),
    ],
  };
}

function recorded(): { methods: string[]; env: string[] } {
  if (!fs.existsSync(recordFile)) return { methods: [], env: [] };
  const lines = fs
    .readFileSync(recordFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    methods: lines.filter((l) => l.method).map((l) => l.method),
    env: lines.find((l) => l.env)?.env ?? [],
  };
}

describe("probeMcpServer over stdio", () => {
  it("lists tools, resources and prompts, and never calls a tool", async () => {
    const r = await probeMcpServer(mock("normal"), { timeoutMs: 15_000 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("connected");
    expect(r.tools.map((t) => t.name)).toEqual(["tool_0", "tool_1"]);
    expect(r.resources).toEqual([{ name: "readme", uri: "mock://readme" }]);
    expect(r.prompts).toEqual([
      { name: "summarise", description: "Summarise" },
    ]);
    expect(r.notice).toBe(
      "Results from this server are treated as untrusted text.",
    );
    const { methods } = recorded();
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");
    expect(methods).not.toContain("tools/call");
    expect(methods).not.toContain("resources/read");
    expect(methods).not.toContain("prompts/get");
  });

  it("starts the server with the same environment as a real run, nothing more", async () => {
    process.env.MCPW_PROBE_CANARY = "should-not-leak";
    await probeMcpServer(mock("normal", { EXTRA_SETTING: "1" }), {
      timeoutMs: 15_000,
    });
    const { env } = recorded();
    expect(env).toContain("EXTRA_SETTING");
    expect(env).toContain("MOCK_MCP_MODE");
    expect(env).not.toContain("MCPW_PROBE_CANARY");
  });

  it("follows tools/list pagination", async () => {
    const r = await probeMcpServer(mock("paged"), { timeoutMs: 15_000 });
    expect(r.tools.map((t) => t.name)).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
      "tool_3",
      "tool_4",
    ]);
  });

  it("normalises descriptions and flags instruction-like text as data", async () => {
    const r = await probeMcpServer(mock("hostile"), { timeoutMs: 15_000 });
    const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    expect(byName.get_file.instructionLike.length).toBeGreaterThan(0);
    expect(byName.hidden.instructionLike).toContain(
      "contains hidden characters",
    );
    expect(byName.hidden.description).not.toMatch(/[\u202E\u202C\u200B]/);
    expect(byName.long.truncated).toBe(true);
    expect([...byName.long.description].length).toBe(1024);
    // The probe reports; it does not refuse
    expect(r.ok).toBe(true);
    expect(recorded().methods).not.toContain("tools/call");
  });

  it("says when a server offers no tools", async () => {
    const r = await probeMcpServer(mock("no-tools"), { timeoutMs: 15_000 });
    expect(r.ok).toBe(true);
    expect(r.tools).toEqual([]);
    expect(r.hints.map((h) => h.code)).toEqual(["no-tools"]);
  });

  it("returns masked stderr when the server exits before the handshake", async () => {
    const r = await probeMcpServer(mock("exit", { MOCK_MCP_SECRET: SECRET }), {
      timeoutMs: 15_000,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("error");
    expect(r.stderr.lines.join("\n")).toContain("could not authenticate");
    const all = JSON.stringify(r);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(r.hints.map((h) => h.code)).toContain("exited");
  });

  it("caps stderr and keeps the last lines", async () => {
    const r = await probeMcpServer(
      mock("chatty", { MOCK_MCP_SECRET: SECRET }),
      {
        timeoutMs: 15_000,
        stderrCap: 2_000,
      },
    );
    expect(r.ok).toBe(true);
    expect(r.stderr.truncated).toBe(true);
    expect(r.stderr.lines.length).toBeLessThanOrEqual(20);
    expect(r.stderr.lines.at(-1)).toContain("log line 1999");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("times out a server that never answers, and stops it", async () => {
    const started = Date.now();
    const r = await probeMcpServer(mock("hang"), { timeoutMs: 1_500 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("timeout");
    expect(r.hints.map((h) => h.code)).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("gives a fix hint for a command that does not exist", async () => {
    const r = await probeMcpServer(
      {
        name: "missing",
        transport: "stdio",
        command: "mcpw-no-such-program-4e1f",
        args: [],
      },
      { timeoutMs: 10_000 },
    );
    expect(r.ok).toBe(false);
    expect(r.hints.map((h) => h.code)).toContain("command-not-found");
  });
});

describe("probeMcpServer over HTTP", () => {
  it("lists tools from a Streamable HTTP server and never calls one", async () => {
    const server = new MockRevisionServer({ mode: "legacy", toolCount: 3 });
    await server.start();
    try {
      const r = await probeMcpServer(
        { name: "remote", transport: "http", url: server.url },
        { timeoutMs: 10_000 },
      );
      expect(r.ok).toBe(true);
      expect(r.tools.map((t) => t.name)).toEqual([
        "tool_0",
        "tool_1",
        "tool_2",
      ]);
      expect(server.requests.map((q) => q.method)).not.toContain("tools/call");
    } finally {
      await server.stop();
    }
  });

  it("says sign-in is needed when a 401 names its metadata", async () => {
    const server = new MockOAuthMcpServer({ challenge: true });
    await server.start();
    try {
      const r = await probeMcpServer(
        { name: "oauth", transport: "http", url: server.mcpUrl },
        { timeoutMs: 10_000 },
      );
      expect(r.ok).toBe(false);
      expect(r.needsSignIn).toBe(true);
      expect(r.hints.map((h) => h.code)).toContain("sign-in");
    } finally {
      await server.stop();
    }
  });

  it("asks for a key when a 401 names no metadata", async () => {
    const server = new MockOAuthMcpServer({ challenge: false });
    await server.start();
    try {
      const r = await probeMcpServer(
        { name: "keyed", transport: "http", url: server.mcpUrl },
        { timeoutMs: 10_000 },
      );
      expect(r.needsSignIn).toBe(true);
      expect(r.hints.map((h) => h.code)).toContain("needs-key");
    } finally {
      await server.stop();
    }
  });

  it("masks a header value that a server echoes in an error", async () => {
    const server = new MockOAuthMcpServer({ challenge: false });
    await server.start();
    try {
      const token = "abcdef0123456789abcdef0123456789";
      const r = await probeMcpServer(
        {
          name: "keyed",
          transport: "http",
          url: `${server.mcpUrl}?echo=${token}`,
          headers: [
            { name: "Authorization", value: `Bearer ${token}`, secret: true },
          ],
        },
        { timeoutMs: 10_000 },
      );
      expect(JSON.stringify(r)).not.toContain(token);
    } finally {
      await server.stop();
    }
  });
});

describe("fix hints", () => {
  const base = {
    errors: [] as string[],
    timedOut: false,
    stderrLines: 0,
    needsSignIn: false,
    hasMetadata: false,
    platform: "linux" as NodeJS.Platform,
    timeoutMs: 20_000,
  };
  const draft = (command: string): McpServerDraft => ({
    name: "s",
    transport: "stdio",
    command,
  });
  it.each([
    ["npx", "install-node"],
    ["node", "install-node"],
    ["uvx", "install-uv"],
    ["uv", "install-uv"],
    ["docker", "install-docker"],
    ["my-tool", "command-not-found"],
  ])("ENOENT for %s gives %s", (command, code) => {
    const hints = failureHints({
      ...base,
      draft: draft(command),
      errors: [`Failed to connect\nError: command "${command}" not found.`],
    });
    expect(hints.map((h) => h.code)).toEqual([code]);
  });

  it("explains a cmd.exe syntax error for npx on Windows", () => {
    const hints = failureHints({
      ...base,
      draft: draft("npx"),
      platform: "win32",
      errors: [
        "The filename, directory name, or volume label syntax is incorrect.",
      ],
    });
    expect(hints.map((h) => h.code)).toContain("windows-cmd");
  });

  it("names the timeout in seconds", () => {
    const [h] = failureHints({ ...base, draft: draft("npx"), timedOut: true });
    expect(h.text).toContain("20 seconds");
  });

  it("points at the system CA settings for a certificate error", () => {
    const hints = failureHints({
      ...base,
      draft: { name: "r", transport: "http", url: "https://x.example/mcp" },
      errors: [
        "Error: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
      ],
    });
    expect(hints.map((h) => h.code)).toContain("tls");
  });
});
