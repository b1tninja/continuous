import { describe, expect, it } from "vitest";

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

describe("matcher anchoring today (documented, not changed)", () => {
  // Claude Code treats a plain name as exact; here every string is an
  // unanchored regular expression. Pinned so a change is a decision.
  const config: HooksConfig = { PreToolUse: [group("Edit")] };

  it("Edit also matches MultiEdit", () => {
    expect(matched(config, input("MultiEdit"))).toEqual(["Edit"]);
  });

  it("^Edit$ is exact", () => {
    const exact: HooksConfig = { PreToolUse: [group("^Edit$")] };
    expect(matched(exact, input("MultiEdit"))).toEqual([]);
    expect(matched(exact, input("Edit"))).toEqual(["^Edit$"]);
  });
});
