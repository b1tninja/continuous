import { describe, expect, it, vi } from "vitest";
import { IDE } from "../..";
import { loadMarkdownRules } from "./loadMarkdownRules";

vi.mock("../loadLocalAssistants", () => ({
  getAllDotContinueDefinitionFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("@continuedev/config-yaml", () => ({
  markdownToRule: vi.fn((content: string) => ({ rule: content })),
}));

function makeIde(files: Record<string, string>, workspaceDirs: string[]): IDE {
  return {
    getWorkspaceDirs: vi.fn().mockResolvedValue(workspaceDirs),
    fileExists: vi.fn(async (uri: string) => uri in files),
    readFile: vi.fn(async (uri: string) => files[uri]),
  } as unknown as IDE;
}

describe("loadMarkdownRules agent files", () => {
  it("falls through to AGENT.md when AGENTS.md is absent", async () => {
    const ide = makeIde({ "file:///ws/AGENT.md": "agent" }, ["file:///ws"]);
    const { rules } = await loadMarkdownRules(ide);
    expect(rules.map((r) => r.sourceFile)).toEqual(["file:///ws/AGENT.md"]);
  });

  it("falls through to CLAUDE.md when it is the only agent file", async () => {
    const ide = makeIde({ "file:///ws/CLAUDE.md": "claude" }, ["file:///ws"]);
    const { rules } = await loadMarkdownRules(ide);
    expect(rules.map((r) => r.sourceFile)).toEqual(["file:///ws/CLAUDE.md"]);
    expect(rules[0].source).toBe("agentFile");
  });

  it("uses only the first existing file, in AGENTS.md, AGENT.md, CLAUDE.md order", async () => {
    const ide = makeIde(
      {
        "file:///ws/AGENT.md": "agent",
        "file:///ws/CLAUDE.md": "claude",
      },
      ["file:///ws"],
    );
    const { rules } = await loadMarkdownRules(ide);
    expect(rules.map((r) => r.sourceFile)).toEqual(["file:///ws/AGENT.md"]);
  });

  it("prefers AGENTS.md over the others", async () => {
    const ide = makeIde(
      {
        "file:///ws/AGENTS.md": "agents",
        "file:///ws/CLAUDE.md": "claude",
      },
      ["file:///ws"],
    );
    const { rules } = await loadMarkdownRules(ide);
    expect(rules.map((r) => r.sourceFile)).toEqual(["file:///ws/AGENTS.md"]);
  });

  it("uses the first workspace that has an agent file", async () => {
    const ide = makeIde({ "file:///b/CLAUDE.md": "claude" }, [
      "file:///a",
      "file:///b",
    ]);
    const { rules } = await loadMarkdownRules(ide);
    expect(rules.map((r) => r.sourceFile)).toEqual(["file:///b/CLAUDE.md"]);
  });
});
