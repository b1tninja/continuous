import { describe, expect, test } from "vitest";
import { assignMcpToolNames, getToolNameFromMCPServer } from "./mcpToolName";

const id = (serverName: string, toolName: string) => ({
  serverName,
  toolName,
});

describe("assignMcpToolNames: composed-name collisions (TR23)", () => {
  test("the `a`/`a_b` pair no longer shares a name", () => {
    // both compose to a_b_c under the old scheme
    expect(getToolNameFromMCPServer("a", "b_c")).toBe("a_b_c");
    expect(getToolNameFromMCPServer("a_b", "c")).toBe("a_b_c");
    const [first, second] = assignMcpToolNames([
      id("a", "b_c"),
      id("a_b", "c"),
    ]);
    expect(first).not.toBe(second);
    expect(first.startsWith("a_b_c_")).toBe(true);
    expect(second.startsWith("a_b_c_")).toBe(true);
  });

  test("the renamed names do not depend on connection order", () => {
    const one = assignMcpToolNames([id("a", "b_c"), id("a_b", "c")]);
    const two = assignMcpToolNames([id("a_b", "c"), id("a", "b_c")]);
    expect(two).toEqual([one[1], one[0]]);
  });

  test("a collider renames, so neither inherits a rule written for the other", () => {
    const names = assignMcpToolNames([id("a", "b_c"), id("a_b", "c")]);
    expect(names).not.toContain("a_b_c");
  });

  test("a third tool that is not in the collision keeps its name", () => {
    const names = assignMcpToolNames([
      id("a", "b_c"),
      id("a_b", "c"),
      id("docs", "search"),
    ]);
    expect(names[2]).toBe("docs_search");
  });
});

describe("assignMcpToolNames: names that do not collide are unchanged", () => {
  const pairs = [
    ["github", "create_issue"],
    ["Docs Server", "search"],
    ["docs", "docs_search"],
    ["files", "read_file"],
    ["", "tool"],
    ["a", "b"],
    ["a_b", "c"],
  ] as const;

  test("each name is exactly what saved rules and habits already use", () => {
    const names = assignMcpToolNames(pairs.map(([s, t]) => id(s, t)));
    expect(names).toEqual(
      pairs.map(([s, t]) => getToolNameFromMCPServer(s, t)),
    );
  });

  test("a single server behaves as before, alone or among others", () => {
    for (const [s, t] of pairs) {
      expect(assignMcpToolNames([id(s, t)])).toEqual([
        getToolNameFromMCPServer(s, t),
      ]);
    }
  });
});

describe("assignMcpToolNames with bare names (the CLI)", () => {
  const options = { bare: true, reserved: new Set(["Read", "Bash"]) };

  test("a unique tool keeps its own name", () => {
    expect(
      assignMcpToolNames([id("docs", "search"), id("wiki", "lookup")], options),
    ).toEqual(["search", "lookup"]);
  });

  test("two servers with the same tool are both qualified", () => {
    expect(
      assignMcpToolNames([id("docs", "search"), id("wiki", "search")], options),
    ).toEqual(["docs_search", "wiki_search"]);
  });

  test("a tool named like a built-in is qualified", () => {
    expect(
      assignMcpToolNames([id("evil", "Read"), id("evil", "ok")], options),
    ).toEqual(["evil_Read", "ok"]);
  });

  test("a qualified name that meets another tool's bare name is still unique", () => {
    // server `a` offers `x`, server `b` offers `x`, and `c` offers `a_x`
    const names = assignMcpToolNames(
      [id("a", "x"), id("b", "x"), id("c", "a_x")],
      options,
    );
    expect(new Set(names).size).toBe(3);
  });
});

describe("saved names from before the collision check (migration)", () => {
  test("these literal names, as they were written into rules, still come out", () => {
    expect(
      assignMcpToolNames([
        id("GitHub", "create_issue"),
        id("Docs Server", "search"),
        id("docs", "docs_search"),
        id("files", "read_file"),
      ]),
    ).toEqual([
      "github_create_issue",
      "docs_server_search",
      "docs_search",
      "files_read_file",
    ]);
  });
});
