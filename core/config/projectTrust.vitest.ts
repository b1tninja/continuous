import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tryLink } from "../tools/permissions/testLinks";
import {
  beginTrustCheck,
  decideFromFiles,
  folderHasTrustRecord,
  inspectProjectConfig,
  isScopeTrusted,
  pendingProjectTrust,
  readScopeFilesFromDisk,
  relativeProjectPath,
  revokeProjectConfig,
  setProjectConfigTrustedForRun,
  summarizeScopeFiles,
  trustProjectScopes,
  uriToFsPath,
} from "./projectTrust";

let root: string;
let project: string;
let globalDir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cn-trust-")));
  project = path.join(root, "project");
  globalDir = path.join(root, "global");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  setProjectConfigTrustedForRun(false);
  beginTrustCheck();
});

afterEach(() => {
  setProjectConfigTrustedForRun(false);
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("project config trust", () => {
  it("does not apply a folder's MCP files until that fingerprint is saved", () => {
    const file = write(
      ".continuous/mcpServers/lint.json",
      JSON.stringify({
        mcpServers: { lint: { command: "sh", args: ["-c", "echo"] } },
      }),
    );
    const files = [{ path: file, content: fs.readFileSync(file, "utf8") }];
    const first = decideFromFiles(project, "mcp", files, globalDir);
    expect(first.trusted).toBe(false);
    expect(isScopeTrusted(project, "mcp", first.fingerprint, globalDir)).toBe(
      false,
    );

    trustProjectScopes(project, { mcp: first.fingerprint }, globalDir);
    expect(decideFromFiles(project, "mcp", files, globalDir).trusted).toBe(
      true,
    );

    fs.writeFileSync(file, files[0].content.replace("echo", "echo x"));
    const changed = [{ path: file, content: fs.readFileSync(file, "utf8") }];
    expect(decideFromFiles(project, "mcp", changed, globalDir).trusted).toBe(
      false,
    );
  });

  it("trusts every scope for this process when the run flag is set", () => {
    const file = write(
      ".continuous/providers.yaml",
      "providers:\n  - { name: a, provider: openai }\n",
    );
    const files = [{ path: file, content: fs.readFileSync(file, "utf8") }];
    setProjectConfigTrustedForRun(true);
    expect(
      decideFromFiles(project, "providers", files, globalDir).trusted,
    ).toBe(true);
    expect(pendingProjectTrust()).toEqual([]);
  });

  it("refuses to record trust when the global folder is inside the project", () => {
    const inside = path.join(project, ".continuous");
    fs.mkdirSync(inside, { recursive: true });
    expect(isScopeTrusted(project, "mcp", "abc", inside)).toBe(false);
    expect(() => trustProjectScopes(project, { mcp: "abc" }, inside)).toThrow(
      /inside this project/,
    );
  });

  it("forgets a project on revoke and ignores a record that cannot be read", () => {
    trustProjectScopes(project, { mcp: "abc" }, globalDir);
    expect(isScopeTrusted(project, "mcp", "abc", globalDir)).toBe(true);
    expect(revokeProjectConfig(project, globalDir)).toBe(true);
    expect(isScopeTrusted(project, "mcp", "abc", globalDir)).toBe(false);
    expect(revokeProjectConfig(project, globalDir)).toBe(false);

    fs.writeFileSync(path.join(globalDir, "trusted-project.json"), "{");
    expect(isScopeTrusted(project, "mcp", "abc", globalDir)).toBe(false);
  });

  it("skips symlinks and matches a file URI to the same relative path", (ctx) => {
    const file = write(".continue/mcpServers/a.json", "{}\n");
    const link = path.join(project, ".continuous", "mcpServers");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    // A junction on Windows, which needs no privilege; lstat reports it as a
    // link like any other, so the case runs on every platform.
    const made = tryLink(path.dirname(file), link);
    if (!made.ok) return ctx.skip(made.reason);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const found = readScopeFilesFromDisk(project, "mcp");
    expect(found.map((item) => path.basename(item.path))).toEqual(["a.json"]);

    const uri = `file://${project}`;
    expect(relativeProjectPath(project, file)).toBe(
      ".continue/mcpServers/a.json",
    );
    expect(relativeProjectPath(uri, `file://${file}`)).toBe(
      ".continue/mcpServers/a.json",
    );
    expect(uriToFsPath(uri)).toBe(project);
  });

  it("describes MCP files without copying secret values", () => {
    const lines = summarizeScopeFiles("mcp", [
      {
        path: "lint.json",
        content: JSON.stringify({
          mcpServers: {
            lint: {
              command: "sh",
              args: ["-c", "echo"],
              env: { TOKEN: "super-secret-value" },
            },
          },
        }),
      },
    ]);
    expect(lines.join("\n")).toContain("lint: sh -c echo");
    expect(lines.join("\n")).toContain("TOKEN");
    expect(lines.join("\n")).not.toContain("super-secret-value");
  });

  it("lists a project for the CLI and reports trust after it is saved", () => {
    write(
      ".continuous/data/analytics.yaml",
      "data:\n  - { name: analytics, destination: https://example.test/in }\n",
    );
    const before = inspectProjectConfig(project, globalDir);
    expect(before.map((item) => item.scope)).toEqual(["data"]);
    expect(before[0].trusted).toBe(false);
    expect(before[0].lines[0]).toContain("https://example.test/in");

    trustProjectScopes(project, { data: before[0].fingerprint }, globalDir);
    expect(inspectProjectConfig(project, globalDir)[0].trusted).toBe(true);
  });
});

describe("folderHasTrustRecord", () => {
  it("is false for a folder with no trust record, true once any scope is trusted", () => {
    expect(folderHasTrustRecord(project, globalDir)).toBe(false);
    trustProjectScopes(project, { mcp: "fingerprint" }, globalDir);
    expect(folderHasTrustRecord(project, globalDir)).toBe(true);
    revokeProjectConfig(project, globalDir);
    expect(folderHasTrustRecord(project, globalDir)).toBe(false);
  });

  it("is true while this run trusts project configuration", () => {
    setProjectConfigTrustedForRun(true);
    expect(folderHasTrustRecord(project, globalDir)).toBe(true);
  });

  it("is false when the global folder is inside the project", () => {
    const inside = path.join(project, ".global");
    fs.mkdirSync(inside, { recursive: true });
    expect(folderHasTrustRecord(project, inside)).toBe(false);
  });
});
