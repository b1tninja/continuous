import { describe, expect, it } from "vitest";

import { freeBlockFileName, projectBlockFileName } from "./fileNames";

describe("projectBlockFileName", () => {
  it.each([
    ["GitHub Tools", "github-tools.yaml"],
    ["  filesystem  ", "filesystem.yaml"],
    ["my/server:v2", "my-server-v2.yaml"],
    ['a<b>c|d?e*f"g', "a-b-c-d-e-f-g.yaml"],
    ["..\\..\\evil", "evil.yaml"],
    ["../../etc/passwd", "etc-passwd.yaml"],
    ["trailing. ", "trailing.yaml"],
    ["Ünïcödé", "n-c-d.yaml"],
    ["", "mcp-server.yaml"],
    ["***", "mcp-server.yaml"],
    // Device names on Windows, with or without an extension
    ["CON", "mcp-con.yaml"],
    ["nul", "mcp-nul.yaml"],
    ["com1.backup", "mcp-com1.backup.yaml"],
    ["console", "console.yaml"],
  ])("%j -> %s", (name, file) => {
    expect(projectBlockFileName(name)).toBe(file);
  });

  it("never returns a path separator, a drive or a parent folder", () => {
    for (const name of ["C:\\x", "a/b", "..", ".", "a\\..\\b", "~/x"]) {
      const file = projectBlockFileName(name);
      expect(file).not.toMatch(/[\\/:]/);
      expect(file).not.toMatch(/^\./);
    }
  });

  it("keeps a long name within what a file system takes", () => {
    const file = projectBlockFileName("x".repeat(300));
    expect(file.length).toBeLessThanOrEqual(64 + ".yaml".length);
  });
});

describe("freeBlockFileName", () => {
  const dir = "C:\\proj\\.continuous\\mcpServers";

  it("uses the plain name when no file has it", () => {
    expect(freeBlockFileName(dir, "github", () => false)).toBe("github.yaml");
  });

  it("takes the next free number instead of another file's name", () => {
    const have = new Set([`${dir}\\github.yaml`, `${dir}\\github-2.yml`]);
    expect(freeBlockFileName(dir, "GitHub", (f) => have.has(f))).toBe(
      "github-3.yaml",
    );
  });

  it("joins with the folder's own separator", () => {
    const seen: string[] = [];
    freeBlockFileName("/home/me/p/.continuous/mcpServers/", "a", (f) => {
      seen.push(f);
      return false;
    });
    expect(seen[0]).toBe("/home/me/p/.continuous/mcpServers/a.yaml");
  });
});
