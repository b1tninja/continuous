import { describe, expect, it } from "vitest";

import { isBlocked } from "../util/stuckSignals";

import type { Tool } from "..";

import { BuiltInToolNames } from "./builtIn";
import * as definitions from "./definitions";
import {
  MAX_LISTED_TOOLS,
  resolveToolAlias,
  TOOL_NAME_PAIRS,
  unknownToolResult,
} from "./unknownTool";

describe("unknownToolResult", () => {
  it("names the wrong name and lists the tools on offer, in the order offered", () => {
    expect(unknownToolResult("Read", ["read_file", "ls", "grep_search"])).toBe(
      "There is no tool named Read. The tools available are: read_file, ls, grep_search.",
    );
  });

  it("lists a name once", () => {
    expect(unknownToolResult("x", ["a", "b", "a"])).toBe(
      "There is no tool named x. The tools available are: a, b.",
    );
  });

  it("caps the list and says how many names it left out", () => {
    const names = Array.from(
      { length: MAX_LISTED_TOOLS + 7 },
      (_, i) => `t${i}`,
    );
    const text = unknownToolResult("x", names);
    expect(text).toContain(`t${MAX_LISTED_TOOLS - 1}, and 7 more.`);
    expect(text).not.toContain(`t${MAX_LISTED_TOOLS},`);
  });

  it("says so when there are no tools", () => {
    expect(unknownToolResult("x", [])).toBe(
      "There is no tool named x. No tools are available in this turn.",
    );
  });

  it("is not worded as invalid arguments or as a refusal", () => {
    const text = unknownToolResult("Read", ["read_file"]);
    expect(text).not.toMatch(/argument|invalid|please|!/i);
    expect(isBlocked({ tool: "Read", result: text, error: true })).toBe(false);
  });
});

const IDE = [
  { name: "read_file", required: ["filepath"] },
  { name: "run_terminal_command", required: ["command"] },
  { name: "ls" },
  {
    name: "single_find_and_replace",
    required: ["filepath", "old_string", "new_string"],
  },
  { name: "multi_edit", required: ["filepath", "edits"] },
  { name: "grep_search", required: ["query"] },
  { name: "fetch_url_content", required: ["url"] },
  { name: "read_skill", required: ["skillName"] },
  { name: "task_list", required: ["items"] },
  { name: "create_new_file", required: ["filepath", "contents"] },
];
const CLI = [
  { name: "Read", required: ["filepath"] },
  { name: "Bash", required: ["command"] },
  { name: "List", required: ["dirpath"] },
  { name: "Edit", required: ["file_path", "old_string", "new_string"] },
  { name: "MultiEdit", required: ["file_path", "edits"] },
  { name: "Search", required: ["pattern"] },
  { name: "Fetch", required: ["url"] },
  { name: "Skills", required: ["skill_name"] },
  { name: "TaskList", required: ["items"] },
  { name: "Write", required: ["filepath", "content"] },
];

describe("resolveToolAlias", () => {
  it("runs the CLI's Read as the IDE's read_file", () => {
    expect(resolveToolAlias("Read", { filepath: "a.ts" }, IDE)).toEqual({
      name: "read_file",
      args: { filepath: "a.ts" },
    });
  });

  it("runs the IDE's read_file as the CLI's Read", () => {
    expect(resolveToolAlias("read_file", { filepath: "a.ts" }, CLI)).toEqual({
      name: "Read",
      args: { filepath: "a.ts" },
    });
  });

  it("renames the parameters that are spelled differently", () => {
    expect(
      resolveToolAlias(
        "Edit",
        { file_path: "a.ts", old_string: "a", new_string: "b" },
        IDE,
      ),
    ).toEqual({
      name: "single_find_and_replace",
      args: { filepath: "a.ts", old_string: "a", new_string: "b" },
    });
    expect(resolveToolAlias("ls", { dirPath: "src" }, CLI)).toEqual({
      name: "List",
      args: { dirpath: "src" },
    });
    expect(resolveToolAlias("Search", { pattern: "foo" }, IDE)).toEqual({
      name: "grep_search",
      args: { query: "foo" },
    });
    expect(resolveToolAlias("read_skill", { skillName: "s" }, CLI)).toEqual({
      name: "Skills",
      args: { skill_name: "s" },
    });
  });

  it("runs Bash and run_terminal_command as each other when only command and cwd are sent", () => {
    expect(
      resolveToolAlias("Bash", { command: "ls", cwd: "src" }, IDE),
    ).toEqual({
      name: "run_terminal_command",
      args: { command: "ls", cwd: "src" },
    });
    expect(
      resolveToolAlias("run_terminal_command", { command: "ls" }, CLI),
    ).toEqual({ name: "Bash", args: { command: "ls" } });
  });

  it("is not an alias when an argument has no counterpart on the other tool", () => {
    // A timeout in seconds means nothing to run_terminal_command
    expect(
      resolveToolAlias("Bash", { command: "ls", timeout: 300 }, IDE),
    ).toBeUndefined();
    // A background run means nothing to Bash
    expect(
      resolveToolAlias(
        "run_terminal_command",
        { command: "npm run dev", waitForCompletion: false },
        CLI,
      ),
    ).toBeUndefined();
    expect(
      resolveToolAlias("ls", { dirPath: "src", recursive: true }, CLI),
    ).toBeUndefined();
    expect(
      resolveToolAlias("Search", { pattern: "x", path: "src" }, IDE),
    ).toBeUndefined();
  });

  it("is not an alias when the other tool requires a parameter the call lacks", () => {
    // ls needs no path; List does
    expect(resolveToolAlias("ls", {}, CLI)).toBeUndefined();
    expect(resolveToolAlias("ls", undefined, CLI)).toBeUndefined();
  });

  it("is not an alias when the other tool is not on offer", () => {
    expect(
      resolveToolAlias("Read", { filepath: "a.ts" }, [{ name: "ls" }]),
    ).toBeUndefined();
  });

  it("never treats tools that differ in meaning as each other", () => {
    // Write replaces a file; create_new_file refuses an existing one
    expect(
      resolveToolAlias("Write", { filepath: "a", content: "b" }, IDE),
    ).toBeUndefined();
    expect(
      resolveToolAlias(
        "create_new_file",
        { filepath: "a", contents: "b" },
        CLI,
      ),
    ).toBeUndefined();
    expect(
      resolveToolAlias(
        "edit_existing_file",
        { filepath: "a", changes: "b" },
        CLI,
      ),
    ).toBeUndefined();
    expect(resolveToolAlias("view_diff", {}, CLI)).toBeUndefined();
  });
});

describe("TOOL_NAME_PAIRS against the IDE's own tools", () => {
  // The definitions that are plain objects; read_skill is built from the
  // skills on disk, so only its name is checked
  const ideTools = Object.values(definitions).filter(
    (t): t is Tool => typeof t === "object" && !!(t as Tool).function?.name,
  );
  const names = Object.values(BuiltInToolNames) as string[];

  it.each(TOOL_NAME_PAIRS.map((p) => [p.ide, p] as const))(
    "%s exists and has every mapped parameter",
    (_name, pair) => {
      expect(names).toContain(pair.ide);
      const tool = ideTools.find((t) => t.function.name === pair.ide);
      if (!tool) {
        expect(pair.ide).toBe(BuiltInToolNames.ReadSkill);
        return;
      }
      const properties = Object.keys(
        tool.function.parameters?.properties ?? {},
      );
      for (const ideParam of Object.values(pair.params)) {
        expect(properties, `${pair.ide}.${ideParam}`).toContain(ideParam);
      }
      // A required parameter with no counterpart could never be sent
      for (const required of tool.function.parameters?.required ?? []) {
        expect(Object.values(pair.params)).toContain(required);
      }
    },
  );
});
