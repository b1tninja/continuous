import { describe, expect, it } from "vitest";

import { matcherAccepts } from "./hookConfig.js";
import {
  getMatchingGroupsForInput,
  qualifiedMcpToolName,
} from "./hookMatch.js";
import type { HooksConfig, PreToolUseInput } from "./types.js";

const input = (toolName: string, server?: string): PreToolUseInput => ({
  session_id: "s",
  transcript_path: "",
  cwd: "/",
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: {},
  tool_use_id: "t",
  ...(server ? { server } : {}),
});

const group = (matcher?: string) => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [{ type: "command" as const, command: `echo ${matcher}` }],
});

const matched = (config: HooksConfig, i: PreToolUseInput) =>
  getMatchingGroupsForInput(config, "PreToolUse", i.tool_name, i).map(
    (g) => g.matcher ?? "",
  );

describe("qualifiedMcpToolName", () => {
  it("is mcp__<server>__<tool> for an MCP call and absent otherwise", () => {
    expect(qualifiedMcpToolName(input("search", "github"))).toBe(
      "mcp__github__search",
    );
    expect(qualifiedMcpToolName(input("Bash"))).toBeUndefined();
  });
});

describe("matching a tool event", () => {
  it("matches the qualified name for an MCP tool, and keeps the raw name", () => {
    const config: HooksConfig = {
      PreToolUse: [
        group("mcp__github__search"),
        group("^search$"),
        group("mcp__gitlab__.*"),
        group(),
      ],
    };
    expect(matched(config, input("search", "github"))).toEqual([
      "mcp__github__search",
      "^search$",
      "",
    ]);
    expect(matched(config, input("search", "gitlab"))).toEqual([
      "^search$",
      "mcp__gitlab__.*",
      "",
    ]);
  });

  it("never tests the qualified name against a matcher without mcp__", () => {
    const config: HooksConfig = {
      PreToolUse: [group("github"), group("^Bash$")],
    };
    expect(matched(config, input("search", "github"))).toEqual([]);
    expect(matched(config, input("run", "Bash"))).toEqual([]);
  });

  it("a built-in call is matched by its name only", () => {
    const config: HooksConfig = {
      PreToolUse: [group("mcp__github__search"), group("^Bash$")],
    };
    expect(matched(config, input("Bash"))).toEqual(["^Bash$"]);
  });
});

describe("matcher anchoring follows Claude Code (D6)", () => {
  // code.claude.com/docs/en/hooks, "Matcher patterns": only letters, digits,
  // `_`, `-`, spaces, `,` and `|` is an exact name or a list of them; any
  // other character makes an unanchored JavaScript regular expression.
  const tools = [
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "NotebookRead",
    "Write",
    "Bash",
    "mcp__github__search",
  ];
  const accepts = (matcher: string, tool: string) =>
    matcherAccepts(matcher, tool, "PreToolUse");

  it.each<[string, string[]]>([
    ["Edit", ["Edit"]],
    ["Edit|Write", ["Edit", "Write"]],
    ["Edit, Write", ["Edit", "Write"]],
    ["Edit | Write", ["Edit", "Write"]],
    ["mcp__.*", ["mcp__github__search"]],
    ["Notebook.*", ["NotebookEdit", "NotebookRead"]],
    ["^Notebook", ["NotebookEdit", "NotebookRead"]],
    ["Edit.*", ["Edit", "MultiEdit", "NotebookEdit"]],
    ["^Edit$", ["Edit"]],
    ["mcp__github", []],
    ["edit", []],
    ["*", tools],
    ["", tools],
  ])("%j matches %j", (matcher, expected) => {
    expect(tools.filter((tool) => accepts(matcher, tool))).toEqual(expected);
  });

  it("Edit no longer matches MultiEdit or NotebookEdit", () => {
    const config: HooksConfig = { PreToolUse: [group("Edit")] };
    expect(matched(config, input("MultiEdit"))).toEqual([]);
    expect(matched(config, input("NotebookEdit"))).toEqual([]);
    expect(matched(config, input("Edit"))).toEqual(["Edit"]);
  });

  it("an exact mcp__ name matches the qualified name of an MCP tool", () => {
    const config: HooksConfig = {
      PreToolUse: [group("mcp__github__search|mcp__github__list")],
    };
    expect(matched(config, input("search", "github"))).toEqual([
      "mcp__github__search|mcp__github__list",
    ]);
  });

  it("a matcher that does not compile still runs its hook", () => {
    expect(accepts("Edit(", "Bash")).toBe(true);
  });
});
