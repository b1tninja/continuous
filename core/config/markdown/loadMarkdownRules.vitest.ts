import { afterEach, describe, expect, it, vi } from "vitest";
import { IDE } from "../..";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";
import {
  fakeAnthropicKey,
  hiddenFixture,
  hiddenFixtureLoaded,
} from "./instructionFileFixture";
import {
  getInstructionFilesState,
  loadAgentFilesThisSession,
  resetInstructionFilesSession,
  setAgentFileGate,
} from "./instructionFiles";
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

describe("loadMarkdownRules instruction file guards (X20, X29, cap)", () => {
  afterEach(resetInstructionFilesSession);

  it("loads the shared fixture without its hidden characters and reports them", async () => {
    const key = fakeAnthropicKey();
    const ide = makeIde({ "file:///ws/AGENTS.md": hiddenFixture(key) }, [
      "file:///ws",
    ]);
    const { rules } = await loadMarkdownRules(ide);
    expect(rules[0].rule).toBe(hiddenFixtureLoaded(key));
    const { notices, withheld } = getInstructionFilesState();
    expect(withheld).toEqual([]);
    expect(notices.map((n) => [n.kind, n.name])).toEqual([
      ["hidden-characters", "AGENTS.md"],
      ["secret", "AGENTS.md"],
    ]);
  });

  it("guards rule files too", async () => {
    vi.mocked(getAllDotContinueDefinitionFiles).mockResolvedValueOnce([
      { path: "file:///ws/.continuous/rules/a.md", content: "a\u200Bb" },
    ]);
    const { rules } = await loadMarkdownRules(makeIde({}, ["file:///ws"]));
    expect(rules.map((r) => r.rule)).toEqual(["ab"]);
    expect(getInstructionFilesState().notices[0].name).toBe("a.md");
  });

  it("in Restricted Mode reads no AGENTS.md until Load", async () => {
    setAgentFileGate(() => true);
    const ide = makeIde({ "file:///ws/AGENTS.md": "secret plan" }, [
      "file:///ws",
    ]);
    const first = await loadMarkdownRules(ide);
    expect(first.rules).toEqual([]);
    expect(ide.readFile).not.toHaveBeenCalled();
    expect(getInstructionFilesState().withheld).toEqual([
      "file:///ws/AGENTS.md",
    ]);

    loadAgentFilesThisSession();
    const second = await loadMarkdownRules(ide);
    expect(second.rules.map((r) => r.rule)).toEqual(["secret plan"]);
    expect(getInstructionFilesState().withheld).toEqual([]);
  });
});
