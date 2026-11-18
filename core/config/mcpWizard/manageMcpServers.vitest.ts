import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configYamlSchema } from "@continuedev/config-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";

import {
  addMcpServerToProjectFile,
  projectBlockFileName,
} from "./addMcpServer";
import {
  entryToDraft,
  findMcpServers,
  listMcpServers,
  projectMcpServerDir,
  removeMcpServer,
  secretNamesIn,
} from "./manageMcpServers";

/*
  MCPW7: list, find, remove and re-test saved servers, and the "This
  project" writer. Nothing here starts a process.
*/

const CANARY = "ghp_" + "ManageCanary0123456789abcdefABCDEF0123";

const CONFIG = `# My settings
name: Local Config
version: 1.0.0
schema: v1

# Servers I use every day
mcpServers:
  - name: GitHub # the one at work
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-github@2025.4.8"
    env:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
  - name: docs
    url: https://example.com/mcp?api_key=\${{ secrets.DOCS_KEY }}
    type: streamable-http
    requestOptions:
      headers:
        Authorization: Bearer \${{ secrets.DOCS_TOKEN }}
`;

let dir: string;
let project: string;
let file: string;

const loc = () => ({ configPath: file, projectDir: project });

function writeProjectBlock(name: string, body: string) {
  const d = projectMcpServerDir(project);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), body);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpw-manage-"));
  project = path.join(dir, "project");
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(dir, ".continuous"));
  file = path.join(dir, ".continuous", "config.yaml");
  fs.writeFileSync(file, CONFIG);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("listMcpServers", () => {
  it("lists the user config and the project's block files", () => {
    writeProjectBlock(
      "sqlite.yaml",
      "name: sqlite\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: sqlite\n    command: uvx\n    args: [mcp-server-sqlite==0.6.2]\n",
    );
    const { servers, problems } = listMcpServers(loc());
    expect(problems).toEqual([]);
    expect(
      servers.map((s) => [s.name, s.scope, s.transport, s.target]),
    ).toEqual([
      [
        "GitHub",
        "user",
        "stdio",
        "npx -y @modelcontextprotocol/server-github@2025.4.8",
      ],
      [
        "docs",
        "user",
        "streamable-http",
        "https://example.com/mcp?api_key=${{ secrets.DOCS_KEY }}",
      ],
      ["sqlite", "project", "stdio", "uvx mcp-server-sqlite==0.6.2"],
    ]);
    expect(servers[1].secrets).toEqual(["DOCS_KEY", "DOCS_TOKEN"]);
  });

  it("reports a file that does not parse and keeps going", () => {
    writeProjectBlock("broken.yaml", "mcpServers: [\n");
    const { servers, problems } = listMcpServers(loc());
    expect(servers.map((s) => s.name)).toEqual(["GitHub", "docs"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/broken\.yaml does not parse/);
  });

  it("works with no config file and no project folder", () => {
    const r = listMcpServers({ configPath: path.join(dir, "none.yaml") });
    expect(r).toEqual({ servers: [], problems: [] });
  });

  it("finds by name in any case, optionally in one scope", () => {
    expect(findMcpServers("github", loc()).map((s) => s.name)).toEqual([
      "GitHub",
    ]);
    expect(findMcpServers("github", loc(), "project")).toEqual([]);
  });
});

describe("removeMcpServer", () => {
  it("removes a user entry and keeps comments and the other entries", () => {
    const r = removeMcpServer("github", loc());
    expect(r).toMatchObject({
      ok: true,
      scope: "user",
      fileDeleted: false,
      secrets: ["GITHUB_TOKEN"],
    });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# Servers I use every day");
    expect(text).not.toContain("server-github");
    expect(text).toContain("name: docs");
    expect(configYamlSchema.safeParse(YAML.parse(text)).success).toBeTruthy();
  });

  it("deletes a project block file that held only that server", () => {
    writeProjectBlock(
      "sqlite.yaml",
      "name: sqlite\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: sqlite\n    command: uvx\n",
    );
    const r = removeMcpServer("sqlite", loc());
    expect(r).toMatchObject({ ok: true, scope: "project", fileDeleted: true });
    expect(
      fs.existsSync(path.join(projectMcpServerDir(project), "sqlite.yaml")),
    ).toBe(false);
  });

  it("asks for a scope when the name is in both places", () => {
    writeProjectBlock(
      "github.yaml",
      "name: g\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: github\n    command: npx\n",
    );
    const r = removeMcpServer("GitHub", loc());
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(fs.readFileSync(file, "utf8")).toBe(CONFIG);
    expect(removeMcpServer("GitHub", loc(), "user")).toMatchObject({
      ok: true,
    });
  });

  it("refuses an unknown name and changes nothing", () => {
    expect(removeMcpServer("nope", loc())).toMatchObject({
      ok: false,
      reason: "not-found",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(CONFIG);
  });
});

describe("entryToDraft", () => {
  it("fills secret references for a test and names the missing ones", () => {
    const [docs] = findMcpServers("docs", loc());
    const { draft, missing } = entryToDraft(docs.entry, (n) =>
      n === "DOCS_TOKEN" ? CANARY : undefined,
    );
    expect(draft.transport).toBe("http");
    expect(draft.headers).toEqual([
      { name: "Authorization", value: `Bearer ${CANARY}`, secret: true },
    ]);
    expect(missing).toEqual(["DOCS_KEY"]);
  });

  it("keeps a stdio entry's command, arguments and environment", () => {
    const [gh] = findMcpServers("GitHub", loc());
    const { draft, missing } = entryToDraft(gh.entry, () => CANARY);
    expect(missing).toEqual([]);
    expect(draft).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
      env: [{ name: "GITHUB_TOKEN", value: CANARY, secret: true }],
    });
  });

  it("turns apiKey into the Authorization header MCPConnection sends", () => {
    const { draft } = entryToDraft(
      { name: "k", url: "https://example.com/mcp", apiKey: "abc" },
      () => undefined,
    );
    expect(draft.headers).toEqual([
      { name: "Authorization", value: "Bearer abc", secret: true },
    ]);
  });

  it("collects secret names from any field", () => {
    expect(
      secretNamesIn({ a: "${{ secrets.A }}", b: ["${{secrets.B}}"] }),
    ).toEqual(["A", "B"]);
  });
});

describe("addMcpServerToProjectFile", () => {
  const ide = {
    readSecrets: async () => ({}),
    writeSecrets: async () => {},
  };
  const secrets = () => ({
    ide,
    storage: "env" as const,
    continueDir: path.join(dir, ".continuous"),
  });

  it("writes one block file with secrets as references", async () => {
    const r = await addMcpServerToProjectFile(
      {
        name: "Team Tracker",
        transport: "stdio",
        command: "npx",
        args: ["-y", "tracker-mcp@1.2.3"],
        env: [{ name: "TRACKER_TOKEN", value: CANARY, secret: true }],
      },
      { projectDir: project, configPath: file, secrets: secrets() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(path.basename(r.file)).toBe("team-tracker.yaml");
    const text = fs.readFileSync(r.file, "utf8");
    expect(text).not.toContain(CANARY);
    const parsed = YAML.parse(text);
    expect(configYamlSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.mcpServers[0].env.TRACKER_TOKEN).toMatch(
      /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/,
    );
    expect(findMcpServers("team tracker", loc())[0].scope).toBe("project");
  });

  it("refuses a name already in the user config", async () => {
    const r = await addMcpServerToProjectFile(
      { name: "github", transport: "stdio", command: "npx" },
      { projectDir: project, configPath: file },
    );
    expect(r).toMatchObject({ ok: false, reason: "duplicate" });
    expect(fs.existsSync(projectMcpServerDir(project))).toBe(false);
  });

  it("makes a file name from any server name", () => {
    expect(projectBlockFileName("GitHub Tools")).toBe("github-tools.yaml");
    expect(projectBlockFileName("../../etc")).toBe("etc.yaml");
    expect(projectBlockFileName("  ")).toBe("mcp-server.yaml");
  });
});
