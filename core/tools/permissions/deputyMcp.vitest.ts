import { describe, expect, it } from "vitest";
import { deputyCallHit, type DeputyCallInput } from "./deputyCall";
import { deputyTargets } from "./deputyTargets";
import { schemaSaysPath } from "./mcpPathSchema";

/**
 * MCP path arguments judged from the tool's own schema (mcpPathSchema.ts),
 * links followed through an injected resolver, and a path inside any root of
 * a multi-root workspace. Fakes only: no file system, no host.
 */
const CWD = "/home/dev/shop";
const call = (over: Partial<DeputyCallInput>) =>
  deputyCallHit({
    toolName: "mcp__files__open",
    parsedArgs: {},
    cwd: CWD,
    home: "/home/dev",
    flavor: "posix",
    mcp: true,
    ...over,
  });

describe("an MCP argument the schema calls a path", () => {
  it("is not read by name alone when it hides under another name", () => {
    expect(call({ parsedArgs: { where: "/etc/passwd" } })).toBeUndefined();
  });

  it.each([
    ["format uri", { where: { type: "string", format: "uri" } }],
    [
      "format uri-reference",
      { where: { type: "string", format: "uri-reference" } },
    ],
    ["format file-uri", { where: { type: "string", format: "file-uri" } }],
    [
      "a path in the description",
      { where: { type: "string", description: "Absolute path to the file" } },
    ],
    [
      "anyOf one branch",
      {
        where: { anyOf: [{ type: "null" }, { type: "string", format: "uri" }] },
      },
    ],
  ])("is judged: %s", (_, properties) => {
    const hit = call({
      parsedArgs: { where: "/etc/passwd" },
      schema: { type: "object", properties },
    });
    expect(hit?.kind).toBe("file-deputy");
    expect(hit?.path).toContain("outside the workspace");
  });

  it("is judged inside an array and a nested object", () => {
    const schema = {
      properties: {
        batch: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              items: { type: "string", format: "uri-reference" },
            },
          },
        },
      },
    };
    expect(
      call({
        parsedArgs: { batch: { targets: ["a.txt", "/etc/hosts"] } },
        schema,
      })?.kind,
    ).toBe("file-deputy");
    expect(
      call({
        parsedArgs: { batch: { targets: ["a.txt", "b/c.txt"] } },
        schema,
      }),
    ).toBeUndefined();
  });

  it("is left alone when the schema says nothing, or the value is a web URL", () => {
    const schema = {
      properties: {
        q: { type: "string", description: "What to look for" },
        link: { type: "string", format: "uri" },
      },
    };
    expect(
      call({
        parsedArgs: { q: "/etc/passwd", link: "https://example.com/a" },
        schema,
      }),
    ).toBeUndefined();
  });

  it("does not take a loose word for a path", () => {
    for (const description of [
      "Query text",
      "A file of results",
      "Name of the repository",
      "How many results",
    ]) {
      expect(schemaSaysPath({ description }), description).toBe(false);
    }
  });

  it("only adds: the name rule still covers a path the schema does not mention", () => {
    expect(
      call({ parsedArgs: { path: "/etc/hosts" }, schema: { properties: {} } })
        ?.kind,
    ).toBe("file-deputy");
  });

  it("is ask-only: the person's own switch still turns it off", () => {
    expect(
      call({
        parsedArgs: { where: "/etc/passwd" },
        schema: { properties: { where: { format: "uri" } } },
        approval: { builtin: { "ask-outside-paths": false } },
      }),
    ).toBeUndefined();
  });

  it("targets list the schema paths and nothing else", () => {
    expect(
      deputyTargets("mcp__x__y", { a: "/x", b: "/y", c: "not a path" }, true, {
        properties: { a: { format: "uri" } },
      })?.paths,
    ).toEqual(["/x"]);
  });
});

describe("a link followed for an MCP path", () => {
  const resolvePath = (raw: string) =>
    raw === "notes/link.txt"
      ? { path: "/srv/secret/link.txt", withinWorkspace: false }
      : raw === "/etc/alias"
        ? { path: `${CWD}/inside.txt`, withinWorkspace: true }
        : undefined;

  it("asks when the real path leaves the workspace though the text is inside", () => {
    expect(
      call({ parsedArgs: { path: "notes/link.txt" }, resolvePath })?.path,
    ).toContain("/srv/secret/link.txt");
    expect(call({ parsedArgs: { path: "notes/link.txt" } })).toBeUndefined();
  });

  it("never loosens: text outside still asks when the link lands inside", () => {
    expect(
      call({ parsedArgs: { path: "/etc/alias" }, resolvePath })?.kind,
    ).toBe("file-deputy");
  });

  it("a plain inside path stays quiet", () => {
    expect(
      call({ parsedArgs: { path: "a/b.txt" }, resolvePath }),
    ).toBeUndefined();
  });
});

describe("a multi-root workspace", () => {
  const roots = [CWD, "/home/dev/lib"];
  const grep = (path: string, workspaceDirs?: string[]) =>
    deputyCallHit({
      toolName: "grep_search",
      parsedArgs: { query: "x", path },
      cwd: CWD,
      home: "/home/dev",
      flavor: "posix",
      workspaceDirs,
    });

  it("a path in the second root is inside", () => {
    expect(grep("/home/dev/lib/src", roots)).toBeUndefined();
    expect(grep("/home/dev/lib/src")?.kind).toBe("file-deputy");
  });

  it("a path in neither root asks", () => {
    expect(grep("/home/dev/other", roots)?.kind).toBe("file-deputy");
  });

  it("a sibling that shares a name prefix with a root is not inside it", () => {
    expect(grep("/home/dev/library", roots)?.kind).toBe("file-deputy");
  });

  it("glob and a climb to the second root", () => {
    const glob = (pattern: string, dirs?: string[]) =>
      deputyCallHit({
        toolName: "file_glob_search",
        parsedArgs: { pattern },
        cwd: CWD,
        home: "/home/dev",
        flavor: "posix",
        workspaceDirs: dirs,
      });
    expect(glob("/home/dev/lib/**", roots)).toBeUndefined();
    expect(glob("../lib/**", roots)).toBeUndefined();
    expect(glob("../lib/**")?.kind).toBe("file-deputy");
    expect(glob("/etc/**", roots)?.kind).toBe("file-deputy");
  });

  it("the tool's own answer still wins for a built-in file tool", () => {
    expect(
      deputyCallHit({
        toolName: "read_file",
        parsedArgs: { filepath: "/home/dev/lib/a.ts" },
        resolved: { path: "/home/dev/lib/a.ts", withinWorkspace: false },
        cwd: CWD,
        home: "/home/dev",
        flavor: "posix",
        workspaceDirs: roots,
      })?.kind,
    ).toBe("file-deputy");
  });
});
