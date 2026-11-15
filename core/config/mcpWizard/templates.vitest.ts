import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeLaunch } from "./analyzeLaunch";
import {
  MCP_TEMPLATES,
  MCP_TEMPLATES_FILE,
  type McpTemplate,
  templateSummaries,
  templateToDraft,
  validateTemplate,
  validateTemplates,
} from "./templates";
import type { McpServerDraft } from "./types";

/*
  MCPW6: the bundled templates are data, pinned and dated, and every one of
  them passes the launch-safety analysis once its required values are in.
*/

const IDS = [
  "filesystem",
  "git",
  "fetch",
  "memory",
  "sequential-thinking",
  "github",
  "playwright",
  "sqlite",
];

/** The draft with every required value filled in, as the Simple screen would. */
function filled(t: McpTemplate): McpServerDraft {
  const { draft, fields } = templateToDraft(t);
  const args = [...(draft.args ?? [])];
  for (const f of fields) {
    if (f.target === "argument" && f.argIndex !== undefined) {
      args[f.argIndex] = f.format === "filepath" ? "/home/me/work" : "value";
    }
  }
  const env = (draft.env ?? []).map((v) =>
    v.secret && v.value === "" ? { ...v, value: "ghp_" + "a".repeat(36) } : v,
  );
  return { ...draft, args, env };
}

describe("the bundled file", () => {
  it("holds exactly the eight templates", () => {
    expect(MCP_TEMPLATES.map((t) => t.id)).toEqual(IDS);
  });

  it("is valid", () => {
    expect(validateTemplates()).toEqual([]);
  });

  it("is the only data file: the module serves the JSON as it is", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "templates.json"), "utf8"),
    );
    expect(MCP_TEMPLATES_FILE.templates).toEqual(raw.templates);
    expect(MCP_TEMPLATES_FILE.checked).toBe(raw.checked);
  });

  it("dates every pin and the file", () => {
    expect(MCP_TEMPLATES_FILE.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const t of MCP_TEMPLATES) {
      expect(t.package.versionChecked, t.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.package.versionChecked <= MCP_TEMPLATES_FILE.checked).toBe(true);
    }
  });

  it("pins every package to an exact version", () => {
    for (const t of MCP_TEMPLATES) {
      const p = t.package;
      if (p.registryType === "oci") {
        expect(p.identifier, t.id).toMatch(/:v?\d+\.\d+\.\d+$|@sha256:/);
      } else {
        expect(p.version, t.id).toMatch(/^\d+(?:\.\d+)+$/);
      }
    }
  });

  it("has no network address to fetch at run time, only the repository link", () => {
    const text = fs.readFileSync(path.join(__dirname, "templates.ts"), "utf8");
    expect(text).not.toMatch(/\bfetch\(|https?:\/\/registry|pypi\.org/);
  });
});

describe("each template", () => {
  it.each(IDS)(
    "%s passes the launch analysis without a block or an unpinned warning",
    (id) => {
      const t = MCP_TEMPLATES.find((x) => x.id === id)!;
      const a = analyzeLaunch(filled(t), { platform: "linux" });
      expect(a.blocked, JSON.stringify(a.findings)).toBe(false);
      const codes = a.findings.map((f) => f.code);
      expect(codes).not.toContain("unpinned-package");
      expect(codes).not.toContain("docker-unpinned-image");
      expect(codes).not.toContain("secret-literal");
    },
  );

  it.each(IDS)("%s also passes on Windows", (id) => {
    const t = MCP_TEMPLATES.find((x) => x.id === id)!;
    expect(analyzeLaunch(filled(t), { platform: "win32" }).blocked).toBe(false);
  });
});

describe("templateToDraft", () => {
  const get = (id: string) => MCP_TEMPLATES.find((t) => t.id === id)!;

  it("filesystem asks for a folder, as a required filepath argument", () => {
    const { draft, fields } = templateToDraft(get("filesystem"));
    expect(draft.command).toBe("npx");
    expect(draft.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem@2.3.0",
      "",
    ]);
    expect(fields).toEqual([
      expect.objectContaining({
        target: "argument",
        isRequired: true,
        isSecret: false,
        format: "filepath",
        argIndex: 2,
      }),
    ]);
  });

  it("GitHub runs the pinned image and asks for the token as a secret", () => {
    const { draft, fields } = templateToDraft(get("github"));
    expect(draft.command).toBe("docker");
    expect(draft.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server:v2.1.0",
    ]);
    expect(draft.env).toEqual([
      { name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "", secret: true },
    ]);
    expect(fields[0]).toMatchObject({ isRequired: true, isSecret: true });
  });

  it("Playwright runs isolated and is in the web category", () => {
    const t = get("playwright");
    expect(t.category).toBe("web");
    expect(templateToDraft(t).draft.args).toEqual([
      "-y",
      "@playwright/mcp@0.0.85",
      "--isolated",
    ]);
  });

  it("uvx templates pin with @ and offer optional values only in the fields", () => {
    const git = templateToDraft(get("git"));
    expect(git.draft.command).toBe("uvx");
    expect(git.draft.args).toEqual(["mcp-server-git@2026.11.11"]);
    expect(git.fields).toEqual([
      expect.objectContaining({ name: "--repository", isRequired: false }),
    ]);
    expect(git.fields[0].argIndex).toBeUndefined();
    const sqlite = templateToDraft(get("sqlite"));
    expect(sqlite.draft.args).toEqual([
      "mcp-server-sqlite@2025.4.25",
      "--db-path",
      "",
    ]);
  });

  it("leaves an optional variable out of the draft until it is filled in", () => {
    const { draft, fields } = templateToDraft(get("memory"));
    expect(draft.env).toBeUndefined();
    expect(fields).toEqual([
      expect.objectContaining({
        target: "env",
        name: "MEMORY_FILE_PATH",
        isRequired: false,
      }),
    ]);
  });

  it("summarises the cards for the Start step", () => {
    const cards = templateSummaries();
    expect(cards).toHaveLength(8);
    expect(cards.find((c) => c.id === "fetch")).toMatchObject({
      runtimeHint: "uvx",
      pinned: "mcp-server-fetch@2026.11.11",
    });
  });
});

describe("validateTemplate catches", () => {
  const base = MCP_TEMPLATES.find((t) => t.id === "memory")!;
  const bad = (change: (t: McpTemplate) => void) => {
    const t = structuredClone(base) as McpTemplate;
    change(t);
    return validateTemplate(t, "2026-11-15");
  };

  it("an unpinned or ranged npm version", () => {
    expect(bad((t) => (t.package.version = "latest"))).not.toEqual([]);
    expect(bad((t) => (t.package.version = "^2.0.0"))).not.toEqual([]);
  });

  it("an image without a tag", () => {
    expect(
      bad((t) => {
        t.package.registryType = "oci";
        t.package.runtimeHint = "docker";
        delete t.package.version;
        t.package.identifier = "ghcr.io/x/y";
      }),
    ).not.toEqual([]);
  });

  it("a missing or later check date", () => {
    expect(bad((t) => (t.package.versionChecked = ""))).not.toEqual([]);
    expect(bad((t) => (t.package.versionChecked = "2027-01-01"))).not.toEqual(
      [],
    );
  });

  it("a runtime that does not match the registry, and a secret argument", () => {
    expect(bad((t) => (t.package.runtimeHint = "uvx"))).not.toEqual([]);
    expect(
      bad((t) => {
        t.package.packageArguments = [
          {
            type: "named",
            name: "--token",
            valueHint: "token",
            isSecret: true,
          },
        ];
      }),
    ).not.toEqual([]);
  });

  it("a description over the registry's 100 characters", () => {
    expect(bad((t) => (t.description = "x".repeat(101)))).not.toEqual([]);
  });

  it("an id used twice", () => {
    expect(
      validateTemplates({ checked: "2026-11-15", templates: [base, base] }),
    ).toContain("memory: the id is used twice.");
  });
});
