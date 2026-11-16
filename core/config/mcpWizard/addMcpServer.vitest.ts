import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configYamlSchema } from "@continuedev/config-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";

import { setSecretInEnvFile } from "../../util/secretsFile";

import {
  addMcpServerToUserConfig,
  planMcpServerEntry,
  renderEntryYaml,
} from "./addMcpServer";
import type { McpServerDraft } from "./types";

/*
  MCPW4 and MCPW5: the writer keeps the person's file as it was, adds one
  entry, refuses duplicates and broken files, and moves secrets out.
*/

const CANARY = "ghp_" + "CanaryValue0123456789abcdefABCDEF0123";

const CONFIG = `# My Continuous settings
name: Local Config # the name shown in the picker
version: 1.0.0
schema: v1

models:
  - name: Local
    provider: ollama
    model: qwen3:8b # keep this one

# Servers I use every day
mcpServers:
  - name: GitHub
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-github@2025.4.8"
`;

let dir: string;
let continueDir: string;
let file: string;

function fakeIde(secure = false) {
  const store = new Map<string, string>();
  return {
    store,
    ide: {
      writeSecrets: async (s: Record<string, string>) => {
        if (secure) for (const [k, v] of Object.entries(s)) store.set(k, v);
      },
      readSecrets: async (keys: string[]) =>
        Object.fromEntries(
          keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)!]),
        ),
    },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpw-writer-"));
  continueDir = path.join(dir, ".continuous");
  fs.mkdirSync(continueDir);
  file = path.join(continueDir, "config.yaml");
  fs.writeFileSync(file, CONFIG);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const memory: McpServerDraft = {
  name: "memory",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory@2025.4.25"],
  env: [
    { name: "MEMORY_FILE_PATH", value: "/data/memory.jsonl", secret: false },
  ],
};

describe("addMcpServerToUserConfig", () => {
  it("appends the entry and keeps every comment, key and line", async () => {
    const r = await addMcpServerToUserConfig(memory, { configPath: file });
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    // Everything that was there is still there, in order
    expect(after.startsWith(CONFIG.trimEnd())).toBe(true);
    expect(after).toContain("# Servers I use every day");
    expect(after).toContain("model: qwen3:8b # keep this one");
    const parsed = YAML.parse(after);
    expect(parsed.mcpServers.map((s: any) => s.name)).toEqual([
      "GitHub",
      "memory",
    ]);
    expect(parsed.mcpServers[1]).toEqual({
      name: "memory",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory@2025.4.25"],
      env: { MEMORY_FILE_PATH: "/data/memory.jsonl" },
    });
    expect(configYamlSchema.safeParse(parsed).success).toBe(true);
  });

  it("writes atomically: no temporary file is left behind", async () => {
    await addMcpServerToUserConfig(memory, { configPath: file });
    expect(
      fs.readdirSync(continueDir).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("keeps Windows line endings", async () => {
    fs.writeFileSync(file, CONFIG.replace(/\n/g, "\r\n"));
    await addMcpServerToUserConfig(memory, { configPath: file });
    const after = fs.readFileSync(file, "utf8");
    expect(
      after
        .split("\n")
        .every((l, i, all) => i === all.length - 1 || l.endsWith("\r")),
    ).toBe(true);
  });

  it("adds mcpServers to a file that has none", async () => {
    fs.writeFileSync(file, "name: Local Config\nversion: 1.0.0\nschema: v1\n");
    const r = await addMcpServerToUserConfig(memory, { configPath: file });
    expect(r.ok).toBe(true);
    expect(YAML.parse(fs.readFileSync(file, "utf8")).mcpServers).toHaveLength(
      1,
    );
  });

  it("refuses a name already in use, whatever its case, and changes nothing", async () => {
    const before = fs.readFileSync(file);
    const r = await addMcpServerToUserConfig(
      { ...memory, name: "github" },
      { configPath: file },
    );
    expect(r).toMatchObject({
      ok: false,
      reason: "duplicate",
      suggestion: "github-2",
    });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses a file that does not parse, with the line, and changes nothing", async () => {
    const broken =
      "name: Local\nmodels:\n  - name: a\n   provider: [unclosed\n";
    fs.writeFileSync(file, broken);
    const r = await addMcpServerToUserConfig(memory, { configPath: file });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unparseable");
      expect(r.error).toMatch(/line \d+/);
    }
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
  });

  it("refuses when there is no config.yaml", async () => {
    fs.rmSync(file);
    const r = await addMcpServerToUserConfig(memory, { configPath: file });
    expect(r).toMatchObject({ ok: false, reason: "no-file" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("stores a secret value and writes only a reference", async () => {
    const { ide } = fakeIde();
    const r = await addMcpServerToUserConfig(
      {
        name: "github-pat",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
        env: [{ name: "GITHUB_TOKEN", value: CANARY, secret: true }],
      },
      { configPath: file, secrets: { ide, storage: "env", continueDir } },
    );
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toContain(CANARY);
    expect(after).toContain(
      "GITHUB_TOKEN: ${{ secrets.GITHUB_PAT_GITHUB_TOKEN }}",
    );
    expect(fs.readFileSync(path.join(continueDir, ".env"), "utf8")).toContain(
      CANARY,
    );
    // The value is nowhere in the result
    expect(JSON.stringify(r)).not.toContain(CANARY);
    if (r.ok) {
      expect(r.secretsStored).toEqual([
        { name: "GITHUB_PAT_GITHUB_TOKEN", location: "env" },
      ]);
    }
  });

  it("uses secure storage when asked", async () => {
    const { ide, store } = fakeIde(true);
    const r = await addMcpServerToUserConfig(
      {
        name: "remote",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: [
          { name: "Authorization", value: `Bearer ${CANARY}`, secret: true },
        ],
      },
      { configPath: file, secrets: { ide, storage: "secure", continueDir } },
    );
    expect(r.ok).toBe(true);
    expect(store.get("REMOTE_AUTHORIZATION")).toBe(CANARY);
    const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.mcpServers[1]).toEqual({
      name: "remote",
      url: "https://mcp.example.com/mcp",
      type: "streamable-http",
      requestOptions: {
        headers: {
          Authorization: "Bearer ${{ secrets.REMOTE_AUTHORIZATION }}",
        },
      },
    });
    expect(fs.existsSync(path.join(continueDir, ".env"))).toBe(false);
  });

  it("moves a key out of the URL query", async () => {
    const { ide } = fakeIde();
    const r = await addMcpServerToUserConfig(
      {
        name: "q",
        transport: "sse",
        url: `https://x.example/sse?api_key=${CANARY}&v=1`,
      },
      { configPath: file, secrets: { ide, storage: "env", continueDir } },
    );
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain(
      "url: https://x.example/sse?api_key=${{ secrets.Q_API_KEY }}&v=1",
    );
    expect(after).not.toContain(CANARY);
  });

  it("never overwrites another server's secret of the same name", async () => {
    setSecretInEnvFile(
      continueDir,
      "GITHUB_PAT_GITHUB_TOKEN",
      "older-value-kept",
    );
    const { ide } = fakeIde();
    const r = await addMcpServerToUserConfig(
      {
        name: "github-pat",
        transport: "stdio",
        command: "node",
        args: ["s.js"],
        env: [{ name: "GITHUB_TOKEN", value: CANARY, secret: true }],
      },
      { configPath: file, secrets: { ide, storage: "env", continueDir } },
    );
    expect(r.ok && r.secretsStored[0].name).toBe("GITHUB_PAT_GITHUB_TOKEN_2");
    const env = fs.readFileSync(path.join(continueDir, ".env"), "utf8");
    expect(env).toContain("older-value-kept");
    expect(env).toContain(CANARY);
  });

  it("leaves an empty .env line for a secret with no value yet", async () => {
    const { ide } = fakeIde();
    const r = await addMcpServerToUserConfig(
      {
        name: "brave",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search@0.6.2"],
        env: [{ name: "BRAVE_API_KEY", value: "", secret: true }],
      },
      { configPath: file, secrets: { ide, storage: "env", continueDir } },
    );
    expect(r.ok && r.secretsPending).toEqual(["BRAVE_API_KEY"]);
    expect(fs.readFileSync(path.join(continueDir, ".env"), "utf8")).toMatch(
      /^BRAVE_API_KEY=$/m,
    );
  });

  it("refuses secrets when there is no store, and changes nothing", async () => {
    const before = fs.readFileSync(file);
    const r = await addMcpServerToUserConfig(
      { ...memory, env: [{ name: "API_KEY", value: CANARY, secret: true }] },
      { configPath: file },
    );
    expect(r).toMatchObject({ ok: false, reason: "secret" });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("refuses a value that still refers to another tool's variable", async () => {
    const r = await addMcpServerToUserConfig(
      {
        ...memory,
        env: [{ name: "TOKEN", value: "${input:github_token}", secret: false }],
      },
      { configPath: file },
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("keeps an existing ${{ secrets.X }} reference as it is", async () => {
    const r = await addMcpServerToUserConfig(
      {
        ...memory,
        env: [
          { name: "TOKEN", value: "${{ secrets.MY_TOKEN }}", secret: true },
        ],
      },
      { configPath: file },
    );
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain(
      "TOKEN: ${{ secrets.MY_TOKEN }}",
    );
  });

  it("refuses a remote server without an http(s) URL", async () => {
    const r = await addMcpServerToUserConfig(
      { name: "r", transport: "http", url: "ftp://x" },
      { configPath: file },
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("planMcpServerEntry and renderEntryYaml", () => {
  it("is pure and shows references, never values", () => {
    const plan = planMcpServerEntry({
      name: "gh",
      transport: "stdio",
      command: "npx",
      args: ["-y", "x@1.0.0"],
      env: [{ name: "GITHUB_TOKEN", value: CANARY, secret: true }],
      connectionTimeoutMs: 60_000,
    });
    const text = renderEntryYaml(plan.entry);
    expect(text).not.toContain(CANARY);
    expect(text).toContain("GITHUB_TOKEN: ${{ secrets.GH_GITHUB_TOKEN }}");
    expect(text).toContain("connectionTimeout: 60000");
    expect(plan.secrets.map((s) => s.name)).toEqual(["GH_GITHUB_TOKEN"]);
  });
});
