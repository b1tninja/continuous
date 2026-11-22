import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";

import {
  entryToEditDraft,
  mergeEditedEntry,
  moveMcpServer,
  secretLookingArgs,
  updateMcpServer,
} from "./editMcpServers";
import {
  listMcpServers,
  type McpServerListing,
  projectMcpServerDir,
} from "./manageMcpServers";

const TOKEN = "ghp_" + "Ed1tC4n4ry".repeat(4);

const CONFIG = `# my own settings
name: test
version: 1.0.0
schema: v1
models: [] # none yet
mcpServers:
  # the one for issues
  - name: github
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-github" # pinned later
    env:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      LOG_LEVEL: debug
  # docs search
  - name: docs
    url: https://docs.example.com/mcp
    apiKey: \${{ secrets.DOCS_KEY }}
    requestOptions:
      verifySsl: false
      headers:
        X-Team: blue
  - name: inline
    command: node
    args: [server.js, --token, ${TOKEN}]
    env:
      API_KEY: ${TOKEN}
`;

let dir: string;
let configPath: string;
let continueDir: string;
let projectDir: string;
let written: Record<string, string>;

const secrets = () => ({
  ide: {
    readSecrets: async (names: string[]) =>
      Object.fromEntries(
        names.filter((n) => n in written).map((n) => [n, written[n]]),
      ),
    writeSecrets: async (s: Record<string, string>) => {
      Object.assign(written, s);
    },
  },
  storage: "secure" as const,
  continueDir,
});

const find = (name: string, scope?: "user" | "project"): McpServerListing => {
  const s = listMcpServers({ configPath, projectDir }).servers.find(
    (x) => x.name === name && (!scope || x.scope === scope),
  );
  if (!s) throw new Error(`no ${name}`);
  return s;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-edit-"));
  continueDir = path.join(dir, "global");
  projectDir = path.join(dir, "project");
  fs.mkdirSync(continueDir);
  fs.mkdirSync(projectDir);
  configPath = path.join(continueDir, "config.yaml");
  fs.writeFileSync(configPath, CONFIG);
  written = {};
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("entryToEditDraft", () => {
  it("keeps references as references and marks a written credential", () => {
    const { draft, keptKeys } = entryToEditDraft(find("inline").entry);
    expect(draft.transport).toBe("stdio");
    expect(draft.args).toEqual(["server.js", "--token", TOKEN]);
    expect(draft.secretArgs).toEqual([2]);
    expect(draft.env).toEqual([
      { name: "API_KEY", value: TOKEN, secret: true },
    ]);
    expect(keptKeys).toEqual([]);

    const github = entryToEditDraft(find("github").entry).draft;
    expect(github.env).toEqual([
      {
        name: "GITHUB_TOKEN",
        value: "${{ secrets.GITHUB_TOKEN }}",
        secret: true,
      },
      { name: "LOG_LEVEL", value: "debug", secret: false },
    ]);
    // Not in the file, so not in the draft: unset stays unset
    expect(github.cwd).toBeUndefined();
    expect(github.connectionTimeoutMs).toBeUndefined();
  });

  it("reads a URL entry without a type as not set, and names what it does not show", () => {
    const { draft, keptKeys } = entryToEditDraft(find("docs").entry);
    expect(draft.transport).toBe("http");
    expect(draft.autoTransport).toBe(true);
    expect(draft.headers).toEqual([
      { name: "X-Team", value: "blue", secret: false },
    ]);
    expect(keptKeys).toEqual(["apiKey", "requestOptions.verifySsl"]);
  });

  it("says when the form cannot edit the transport", () => {
    const r = entryToEditDraft({
      name: "ws",
      url: "wss://x.example",
      type: "websocket",
    });
    expect(r.notEditable).toMatch(/websocket/);
  });
});

describe("secretLookingArgs", () => {
  it("finds a token after its flag and leaves references and paths alone", () => {
    expect(
      secretLookingArgs([
        "--token",
        TOKEN,
        "--dir",
        "/tmp",
        "--api-key",
        "${{ secrets.K }}",
      ]),
    ).toEqual([1]);
  });
});

describe("mergeEditedEntry", () => {
  it("keeps what the form does not show and removes what was left empty", () => {
    const old = {
      name: "docs",
      url: "https://a.example/mcp",
      type: "sse",
      apiKey: "${{ secrets.K }}",
      connectionTimeout: 5000,
      requestOptions: { verifySsl: false, headers: { A: "1" } },
      faviconUrl: "https://a.example/i.png",
    };
    expect(
      mergeEditedEntry(old, { name: "docs", url: "https://b.example/mcp" }),
    ).toEqual({
      name: "docs",
      url: "https://b.example/mcp",
      apiKey: "${{ secrets.K }}",
      requestOptions: { verifySsl: false },
      faviconUrl: "https://a.example/i.png",
    });
  });

  it("reads and removes the tool call limit like any other form setting", () => {
    const old = {
      name: "a",
      command: "npx",
      connectionTimeout: 30_000,
      toolTimeout: 180_000,
    };
    expect(entryToEditDraft(old).draft).toMatchObject({
      connectionTimeoutMs: 30_000,
      toolTimeoutMs: 180_000,
    });
    expect(entryToEditDraft(old).keptKeys).toEqual([]);
    // Reset in the form: the key leaves the file
    expect(
      mergeEditedEntry(old, {
        name: "a",
        command: "npx",
        connectionTimeout: 30_000,
      }),
    ).toEqual({ name: "a", command: "npx", connectionTimeout: 30_000 });
  });

  it("drops the other kind's settings when the kind changes", () => {
    expect(
      mergeEditedEntry(
        { name: "a", url: "https://a.example", apiKey: "k", oauth: {} },
        { name: "a", command: "npx", args: ["x"] },
      ),
    ).toEqual({ name: "a", command: "npx", args: ["x"] });
  });
});

describe("updateMcpServer", () => {
  it("changes one entry and keeps comments, order and the other entries", async () => {
    const r = await updateMcpServer(
      find("github"),
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
        env: [
          {
            name: "GITHUB_TOKEN",
            value: "${{ secrets.GITHUB_TOKEN }}",
            secret: true,
          },
        ],
        connectionTimeoutMs: 45_000,
      },
      { otherNames: ["docs", "inline"], secrets: secrets() },
    );
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    for (const kept of [
      "# my own settings",
      "models: [] # none yet",
      "# the one for issues",
      "# docs search",
      "apiKey: ${{ secrets.DOCS_KEY }}",
      "verifySsl: false",
    ]) {
      expect(text).toContain(kept);
    }
    const github = YAML.parse(text).mcpServers[0];
    expect(github).toEqual({
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
      connectionTimeout: 45_000,
    });
    // Nothing new to store: the reference was kept
    expect(written).toEqual({});
    expect(YAML.parse(text).mcpServers).toHaveLength(3);
  });

  it("leaves unset settings out of the file", async () => {
    await updateMcpServer(
      find("docs"),
      {
        name: "docs",
        transport: "http",
        autoTransport: true,
        url: "https://docs.example.com/v2/mcp",
        headers: [],
      },
      { otherNames: [], secrets: secrets() },
    );
    const docs = YAML.parse(fs.readFileSync(configPath, "utf8")).mcpServers[1];
    expect(docs).toEqual({
      name: "docs",
      url: "https://docs.example.com/v2/mcp",
      apiKey: "${{ secrets.DOCS_KEY }}",
      requestOptions: { verifySsl: false },
    });
    expect("type" in docs).toBe(false);
    expect("connectionTimeout" in docs).toBe(false);
  });

  it("stores a new secret value and writes only its reference", async () => {
    const r = await updateMcpServer(
      find("github"),
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: [],
        env: [{ name: "GITHUB_TOKEN", value: TOKEN, secret: true }],
      },
      { otherNames: [], secrets: secrets() },
    );
    expect(r.ok).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    expect(YAML.parse(text).mcpServers[0].env).toEqual({
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    });
    // The server's own secret is replaced, not copied under a second name
    expect(written).toEqual({ GITHUB_TOKEN: TOKEN });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("refuses a name another server has, and changes nothing", async () => {
    const before = fs.readFileSync(configPath, "utf8");
    const r = await updateMcpServer(
      find("github"),
      { name: "Docs", transport: "stdio", command: "npx" },
      { otherNames: ["docs", "inline"], secrets: secrets() },
    );
    expect(r).toMatchObject({ ok: false, reason: "duplicate" });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("renames in place", async () => {
    const r = await updateMcpServer(
      find("docs"),
      {
        name: "handbook",
        transport: "http",
        autoTransport: true,
        url: "https://docs.example.com/mcp",
        headers: [{ name: "X-Team", value: "blue", secret: false }],
      },
      { otherNames: ["github", "inline"], secrets: secrets() },
    );
    expect(r).toMatchObject({ ok: true, name: "handbook" });
    expect(
      YAML.parse(fs.readFileSync(configPath, "utf8")).mcpServers.map(
        (s: { name: string }) => s.name,
      ),
    ).toEqual(["github", "handbook", "inline"]);
  });

  it("leaves a file that does not parse as it was", async () => {
    const target = find("github");
    fs.writeFileSync(configPath, "mcpServers: [\n  - name: github\n");
    const r = await updateMcpServer(
      target,
      { name: "github", transport: "stdio", command: "npx" },
      { otherNames: [], secrets: secrets() },
    );
    expect(r).toMatchObject({ ok: false, reason: "unparseable" });
  });
});

describe("moveMcpServer", () => {
  const dest = (scope: "user" | "project") => ({
    scope,
    configPath,
    projectDir,
  });

  it("moves to the workspace: writes the block file, then removes the entry", async () => {
    const r = await moveMcpServer(find("github"), dest("project"), {
      taken: [],
      secrets: secrets(),
    });
    expect(r).toMatchObject({
      ok: true,
      removedFromSource: true,
      sourceFileDeleted: false,
    });
    const file = path.join(projectMcpServerDir(projectDir), "github.yaml");
    expect(r.ok && r.to).toBe(file);
    const block = YAML.parse(fs.readFileSync(file, "utf8"));
    expect(block).toMatchObject({ name: "github", schema: "v1" });
    expect(block.mcpServers[0].env.GITHUB_TOKEN).toBe(
      "${{ secrets.GITHUB_TOKEN }}",
    );
    const user = fs.readFileSync(configPath, "utf8");
    expect(YAML.parse(user).mcpServers.map((s: any) => s.name)).toEqual([
      "docs",
      "inline",
    ]);
    // The rest of the person's file is as it was
    expect(user).toContain("# my own settings");
    expect(user).toContain("# docs search");
  });

  it("never writes a credential to the workspace file: it becomes a secret", async () => {
    const r = await moveMcpServer(find("inline"), dest("project"), {
      taken: [],
      secrets: secrets(),
    });
    expect(r.ok).toBe(true);
    const file = path.join(projectMcpServerDir(projectDir), "inline.yaml");
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain(TOKEN);
    const entry = YAML.parse(text).mcpServers[0];
    expect(entry.env.API_KEY).toBe("${{ secrets.INLINE_API_KEY }}");
    expect(entry.args).toEqual([
      "server.js",
      "--token",
      "${{ secrets.INLINE_TOKEN }}",
    ]);
    expect(written).toEqual({ INLINE_API_KEY: TOKEN, INLINE_TOKEN: TOKEN });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("refuses to write a credential to the workspace without a secret store", async () => {
    const r = await moveMcpServer(find("inline"), dest("project"), {
      taken: [],
    });
    expect(r).toMatchObject({ ok: false, reason: "secret" });
    expect(fs.existsSync(projectMcpServerDir(projectDir))).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(CONFIG);
  });

  it("moves back to all projects and deletes the one-server file", async () => {
    await moveMcpServer(find("github"), dest("project"), {
      taken: [],
      secrets: secrets(),
    });
    const r = await moveMcpServer(find("github", "project"), dest("user"), {
      taken: [],
      secrets: secrets(),
    });
    expect(r).toMatchObject({
      ok: true,
      removedFromSource: true,
      sourceFileDeleted: true,
    });
    expect(
      fs.existsSync(path.join(projectMcpServerDir(projectDir), "github.yaml")),
    ).toBe(false);
    const names = YAML.parse(
      fs.readFileSync(configPath, "utf8"),
    ).mcpServers.map((s: any) => s.name);
    expect(names).toEqual(["docs", "inline", "github"]);
  });

  it("refuses when the destination has a server of that name, and says where", async () => {
    const r = await moveMcpServer(find("github"), dest("project"), {
      taken: [
        { name: "GitHub", file: "/p/.continuous/mcpServers/github.yaml" },
      ],
      secrets: secrets(),
    });
    expect(r).toMatchObject({ ok: false, reason: "duplicate" });
    expect(r.ok === false && r.error).toContain(
      "/p/.continuous/mcpServers/github.yaml",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(CONFIG);
  });

  it("does not overwrite another file of the same name", async () => {
    const mcpDir = projectMcpServerDir(projectDir);
    fs.mkdirSync(mcpDir, { recursive: true });
    const other = path.join(mcpDir, "github.yaml");
    fs.writeFileSync(other, "# someone else's notes\n");
    const r = await moveMcpServer(find("github"), dest("project"), {
      taken: [],
      secrets: secrets(),
    });
    expect(r.ok && path.basename(r.to)).toBe("github-2.yaml");
    expect(fs.readFileSync(other, "utf8")).toBe("# someone else's notes\n");
  });

  it("copies under a new name and leaves the source", async () => {
    const r = await moveMcpServer(find("docs"), dest("project"), {
      copy: true,
      newName: "docs-2",
      taken: [{ name: "docs", file: configPath }],
      secrets: secrets(),
    });
    expect(r).toMatchObject({
      ok: true,
      name: "docs-2",
      removedFromSource: false,
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(CONFIG);
    const entry = YAML.parse(
      fs.readFileSync(
        path.join(projectMcpServerDir(projectDir), "docs-2.yaml"),
        "utf8",
      ),
    ).mcpServers[0];
    // Everything the entry had goes along, references as references
    expect(entry).toEqual({
      name: "docs-2",
      url: "https://docs.example.com/mcp",
      apiKey: "${{ secrets.DOCS_KEY }}",
      requestOptions: { verifySsl: false, headers: { "X-Team": "blue" } },
    });
  });

  it("keeps the server when the user file cannot take it", async () => {
    await moveMcpServer(find("github"), dest("project"), {
      taken: [],
      secrets: secrets(),
    });
    const source = find("github", "project");
    fs.writeFileSync(configPath, "mcpServers: [\n");
    const r = await moveMcpServer(source, dest("user"), {
      taken: [],
      secrets: secrets(),
    });
    expect(r).toMatchObject({ ok: false, reason: "unparseable" });
    expect(fs.existsSync(source.file)).toBe(true);
  });
});
