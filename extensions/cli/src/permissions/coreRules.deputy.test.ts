import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ApprovalSettings } from "core/tools/permissions/approval.js";
import type { PolicyLevel } from "core/tools/permissions/policy.js";
import { needsLink, tryLink } from "core/tools/permissions/testLinks.js";
import { removeTestTempDir, testTempDir } from "core/util/testTempDir.js";
import { afterAll, describe, expect, it } from "vitest";

import { evaluateWithCoreRules, toCoreCall } from "./coreRules.js";

/**
 * The confused-deputy rule (core/tools/permissions/deputyPaths.ts) through the
 * CLI's own path: its tool names, its arguments, and the real path and
 * workspace test the CLI works out itself because it has no IDE to do it.
 */
const base = testTempDir("cli-dep-");
const ws = path.join(base, "ws");
const outside = path.join(base, "outside");
fs.mkdirSync(ws);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "target.txt"), "x");
fs.writeFileSync(path.join(ws, "a.ts"), "x");
const link = tryLink(outside, path.join(ws, "link"));
afterAll(() => removeTestTempDir(base));

const levels = (l: PolicyLevel) => ({
  context: l,
  tools: l,
  edits: l,
  plan: l,
  questions: l,
});

const decide = (
  cliToolName: string,
  args: Record<string, unknown>,
  over: {
    level?: PolicyLevel;
    builtin?: ApprovalSettings["builtin"];
    mcp?: { serverName: string; toolName: string };
    mcpSchema?: Record<string, unknown>;
  } = {},
) =>
  evaluateWithCoreRules({
    cliToolName,
    args,
    cliPermission: "allow",
    assistantPermissions: undefined,
    approval: {
      levels: levels(over.level ?? "permissive"),
      ...(over.builtin ? { builtin: over.builtin } : {}),
    },
    mcp: over.mcp,
    mcpSchema: over.mcpSchema,
    isHeadless: false,
    cwd: ws,
  });

describe("toCoreCall: Search", () => {
  it("passes the search path to the core rules", () => {
    expect(
      toCoreCall("Search", { pattern: "x", path: "/etc" })?.parsedArgs,
    ).toEqual({ query: "x", path: "/etc" });
  });
});

describe("the confused-deputy rule through the CLI", () => {
  it("lets a file in the working folder run", async () => {
    for (const [tool, args] of [
      ["Read", { filepath: "a.ts" }],
      ["Write", { filepath: "new.ts" }],
      ["Edit", { file_path: "a.ts" }],
      ["List", { dirpath: "." }],
    ] as const) {
      expect((await decide(tool, args))?.decision, tool).toBe("allow");
    }
  });

  it("asks for a write outside the working folder, and for a climb out", async () => {
    for (const filepath of [
      path.join(outside, "new.txt"),
      `..${path.sep}outside${path.sep}new.txt`,
    ]) {
      const v = await decide("Write", { filepath });
      expect(v?.decision, filepath).toBe("ask");
      expect(v?.source).toBe("protected-path");
    }
  });

  it.skipIf(!link.ok)(
    needsLink(
      "asks for a write or read through a link that leaves the working folder",
      link,
    ),
    async () => {
      for (const [tool, args] of [
        ["Write", { filepath: "link/target.txt" }],
        ["Write", { filepath: "link/not-yet.txt" }],
        ["Edit", { file_path: "link/target.txt" }],
        ["Read", { filepath: "link/target.txt" }],
        ["List", { dirpath: "link" }],
        ["Search", { pattern: "x", path: "link" }],
      ] as const) {
        const v = await decide(tool, args);
        expect(v?.decision, `${tool} ${JSON.stringify(args)}`).toBe("ask");
        expect(v?.source).toBe("protected-path");
      }
    },
  );

  it("asks for a search outside the working folder", async () => {
    const v = await decide("Search", { pattern: "x", path: outside });
    expect(v?.decision).toBe("ask");
    expect((await decide("Search", { pattern: "x" }))?.decision).toBe("allow");
    expect(
      (await decide("Search", { pattern: "x", path: "." }))?.decision,
    ).toBe("allow");
  });

  it("asks for an alternate data stream on Windows, and treats it as a name elsewhere", async () => {
    const v = await decide("Write", { filepath: "notes.txt:hidden" });
    expect(v?.decision).toBe(process.platform === "win32" ? "ask" : "allow");
  });

  it("asks for ~/.continuous and ~/.continue, even to read", async () => {
    for (const filepath of [
      "~/.continuous/permissions.yaml",
      "~/.continue/config.yaml",
    ]) {
      for (const tool of ["Read", "Write"]) {
        const v = await decide(tool, { filepath });
        expect(v?.decision, `${tool} ${filepath}`).toBe("ask");
      }
    }
    expect((await decide("List", { dirpath: "~/.continuous" }))?.decision).toBe(
      "ask",
    );
  });

  it("asks below IDGAF and not at IDGAF", async () => {
    const args = { filepath: path.join(outside, "new.txt") };
    for (const level of ["cautious", "permissive", "automatic"] as const) {
      expect((await decide("Write", args, { level }))?.decision, level).toBe(
        "ask",
      );
    }
    expect((await decide("Write", args, { level: "idgaf" }))?.decision).toBe(
      "allow",
    );
  });

  it("only the builtin switch loosens the working-folder boundary", async () => {
    const args = { filepath: path.join(outside, "new.txt") };
    const off = { builtin: { "ask-outside-paths": false } };
    expect((await decide("Write", args, off))?.decision).toBe("allow");
    // The global folder has no switch.
    expect(
      (await decide("Read", { filepath: "~/.continuous/x" }, off))?.decision,
    ).toBe("ask");
  });
});

describe("MCP file tools through the CLI", () => {
  const mcp = { serverName: "files", toolName: "write_file" };

  it("asks for a path argument outside the working folder", async () => {
    for (const args of [
      { path: path.join(outside, "x.txt") },
      { file_path: "~/.continuous/config.yaml" },
      { destination: "../outside/x" },
      { paths: ["a.ts", path.join(outside, "y")] },
      { options: { directory: outside } },
    ]) {
      const v = await decide(`mcp__files__write_file`, args, { mcp });
      expect(v?.decision, JSON.stringify(args)).toBe("ask");
    }
  });

  it("leaves a path inside, a URL and other arguments alone", async () => {
    for (const args of [
      { path: "a.ts" },
      { url: "https://example.com/x", source: "github" },
      { uri: "https://example.com/x" },
      { content: outside },
    ]) {
      const v = await decide(`mcp__files__write_file`, args, { mcp });
      expect(v?.decision, JSON.stringify(args)).toBe("allow");
    }
  });

  it("follows the same switch and level", async () => {
    const args = { path: path.join(outside, "x.txt") };
    expect(
      (await decide("mcp__files__write_file", args, { mcp, level: "idgaf" }))
        ?.decision,
    ).toBe("allow");
    expect(
      (
        await decide("mcp__files__write_file", args, {
          mcp,
          builtin: { "ask-outside-paths": false },
        })
      )?.decision,
    ).toBe("allow");
  });
});

describe("an MCP tool's path argument, from its schema, through the CLI", () => {
  const mcp = { serverName: "files", toolName: "open" };
  const mcpSchema = {
    type: "object",
    properties: { where: { type: "string", format: "uri-reference" } },
  };

  it("asks for a path under a name no rule knows, when the schema calls it a path", async () => {
    const args = { where: outside };
    expect((await decide("open", args, { mcp }))?.decision).toBe("allow");
    expect((await decide("open", args, { mcp, mcpSchema }))?.decision).toBe(
      "ask",
    );
    expect(
      (await decide("open", { where: "a.ts" }, { mcp, mcpSchema }))?.decision,
    ).toBe("allow");
  });

  it.skipIf(!link.ok)(
    needsLink("asks for a path through a link that leaves the folder", link),
    async () => {
      const v = await decide("open", { path: "link/target.txt" }, { mcp });
      expect(v?.decision).toBe("ask");
      expect(v?.source).toBe("protected-path");
    },
  );
});

describe("File edits outside the working folder, by level, through the CLI", () => {
  const editLevels = (edits: PolicyLevel): ApprovalSettings => ({
    levels: { ...levels("cautious"), edits },
  });
  const run = (
    tool: string,
    args: Record<string, unknown>,
    edits: PolicyLevel,
    over: { headless?: boolean; deny?: string[] } = {},
  ) =>
    evaluateWithCoreRules({
      cliToolName: tool,
      args,
      cliPermission: "ask",
      assistantPermissions: over.deny ? { deny: over.deny } : undefined,
      approval: editLevels(edits),
      isHeadless: over.headless ?? false,
      cwd: ws,
    });
  const targets = [
    ["Write", { filepath: path.join(outside, "new.txt") }],
    ["Edit", { file_path: path.join(outside, "target.txt") }],
    ["MultiEdit", { file_path: path.join(outside, "target.txt") }],
  ] as const;

  it("IDGAF allows each, headless too, by the rules, and names the path", async () => {
    for (const [tool, args] of targets) {
      for (const headless of [false, true]) {
        const v = await run(tool, args, "idgaf", { headless });
        expect(v?.decision, `${tool} headless=${headless}`).toBe("allow");
        expect(v?.by).toBe("rules");
        expect(v?.source).toBe("idgaf");
        expect(v?.reason).toContain("File edits is set to IDGAF");
        expect(v?.reason).toContain("The target is outside the workspace: ");
      }
    }
  });

  it("IDGAF ignores a Never rule on the path", async () => {
    const v = await run("Write", targets[0][1], "idgaf", {
      deny: ["writeFile(**)"],
    });
    expect(v?.decision).toBe("allow");
  });

  it("IDGAF writes the product's own policy files too, and says it would have refused", async () => {
    const v = await run(
      "Write",
      { filepath: path.join(os.homedir(), ".continuous", "permissions.yaml") },
      "idgaf",
    );
    expect(v?.decision).toBe("allow");
    expect(v?.source).toBe("idgaf");
    expect(v?.reason).toContain("would have been refused");
  });

  it("Manual, Cautious, Automatic and Permissive hold each of them", async () => {
    for (const edits of [
      "manual",
      "cautious",
      "automatic",
      "permissive",
    ] as const) {
      for (const [tool, args] of targets) {
        const v = await run(tool, args, edits);
        expect(v?.decision, `${edits} ${tool}`).toBe("ask");
      }
    }
  });
});
