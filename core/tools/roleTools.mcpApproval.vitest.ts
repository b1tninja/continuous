import { describe, expect, it } from "vitest";
import {
  filterToolsForRole,
  isToolAllowedForRole,
  roleRefusal,
  type McpPendingApproval,
  type RoleToolRef,
} from "./roleTools";
import {
  functionFingerprint,
  resolveToolList,
  type HeldToolList,
} from "./toolListHold";

/** An MCP tool as both surfaces give it to the table. */
const mcp = (
  server: string,
  tool: string,
  opts: { readOnlyHint?: boolean; pending?: McpPendingApproval } = {},
): RoleToolRef => ({
  name: `${server}_${tool}`,
  mcp: {
    server,
    tool,
    readOnlyHint: !!opts.readOnlyHint,
    ...(opts.pending ? { pendingApproval: opts.pending } : {}),
  },
});

const names = (refs: RoleToolRef[]) => refs.map((r) => r.name);

describe("TR4: an MCP tool that is not approved is not offered", () => {
  it("a tool of a new server, an added tool and a changed tool are hidden from the agent", () => {
    const tools = [
      mcp("wiki", "search"),
      mcp("fresh", "run", { pending: "new" }),
      mcp("wiki", "delete", { pending: "added" }),
      mcp("wiki", "edit", { pending: "changed" }),
    ];
    expect(names(filterToolsForRole("agent", tools, (t) => t))).toEqual([
      "wiki_search",
    ]);
  });

  it("approving it (the pending mark goes) offers it", () => {
    expect(
      isToolAllowedForRole("agent", mcp("fresh", "run", { pending: "new" })),
    ).toBe(false);
    expect(isToolAllowedForRole("agent", mcp("fresh", "run"))).toBe(true);
  });

  it("IDGAF waives the hold: the tool is offered and its first call pins it", () => {
    const pending = mcp("fresh", "run", { pending: "new" });
    expect(
      isToolAllowedForRole("agent", pending, { approvalWaived: true }),
    ).toBe(true);
    expect(
      roleRefusal("agent", pending, { approvalWaived: true }),
    ).toBeUndefined();
  });

  it("a call to it is refused at execution, saying it waits for approval", () => {
    const fresh = roleRefusal("agent", mcp("fresh", "run", { pending: "new" }));
    expect(fresh).toContain("has not approved it yet");
    expect(fresh).toContain("Do not retry it");
    const changed = roleRefusal(
      "agent",
      mcp("wiki", "edit", { pending: "changed" }),
    );
    expect(changed).toContain("definition changed since the user approved it");
  });

  it("built-in tools are never held", () => {
    expect(isToolAllowedForRole("agent", { name: "Bash" })).toBe(true);
  });
});

describe("TR2: Plan mode gets only trusted read-only MCP tools, and only approved ones", () => {
  const trust = { trustedServers: ["docs"] };

  it("an approved read-only tool of a trusted server is offered", () => {
    expect(
      isToolAllowedForRole(
        "planner",
        mcp("docs", "q", { readOnlyHint: true }),
        { trust },
      ),
    ).toBe(true);
  });

  it("the same tool waiting for approval is not", () => {
    expect(
      isToolAllowedForRole(
        "planner",
        mcp("docs", "q", { readOnlyHint: true, pending: "added" }),
        { trust },
      ),
    ).toBe(false);
  });

  it("an untrusted server's read-only claim opens nothing", () => {
    expect(
      isToolAllowedForRole("planner", mcp("web", "q", { readOnlyHint: true }), {
        trust,
      }),
    ).toBe(false);
  });
});

describe("TR1/TR25: unattended runs get no MCP tools unless listed", () => {
  const listed = { unattendedMcpTools: ["wiki/search", "notes/*"] };

  it("the background role gets none by default", () => {
    expect(isToolAllowedForRole("background", mcp("wiki", "search"))).toBe(
      false,
    );
    expect(roleRefusal("background", mcp("wiki", "search"))).toContain(
      "background.mcpTools",
    );
  });

  it("a headless or Loop worker run (unattended) gets none either, whatever its role", () => {
    expect(
      isToolAllowedForRole("agent", mcp("wiki", "search"), {
        unattended: true,
      }),
    ).toBe(false);
    expect(
      isToolAllowedForRole("agent", { name: "Bash" }, { unattended: true }),
    ).toBe(true);
  });

  it("listed tools are offered: by name, by server/*, by server", () => {
    const tools = [
      mcp("wiki", "search"),
      mcp("wiki", "delete"),
      mcp("notes", "add"),
    ];
    expect(
      names(filterToolsForRole("background", tools, (t) => t, listed)),
    ).toEqual(["wiki_search", "notes_add"]);
    expect(
      names(
        filterToolsForRole("agent", tools, (t) => t, {
          unattended: true,
          unattendedMcpTools: ["wiki"],
        }),
      ),
    ).toEqual(["wiki_search", "wiki_delete"]);
  });

  it("a listed tool of a server never approved is offered: the list is the approval", () => {
    expect(
      isToolAllowedForRole(
        "background",
        mcp("wiki", "search", { pending: "new" }),
        listed,
      ),
    ).toBe(true);
  });

  it("a listed tool added or changed since an approval still waits for the person", () => {
    for (const pending of ["added", "changed"] as const) {
      expect(
        isToolAllowedForRole(
          "background",
          mcp("notes", "add", { pending }),
          listed,
        ),
        pending,
      ).toBe(false);
    }
  });

  it("IDGAF offers them, as it runs everything", () => {
    expect(
      isToolAllowedForRole("background", mcp("wiki", "delete"), {
        approvalWaived: true,
      }),
    ).toBe(true);
  });
});

describe("an approval is a tool list change: it waits while the cache is warm (#895)", () => {
  type T = { function: { name: string; description: string } };
  const asTool = (r: RoleToolRef): T => ({
    function: { name: r.name, description: r.mcp?.tool ?? "" },
  });
  const offered = (refs: RoleToolRef[]) =>
    filterToolsForRole("agent", refs, (t) => t).map(asTool);

  const before = [
    mcp("wiki", "search"),
    mcp("wiki", "add", { pending: "added" }),
  ];
  const after = [mcp("wiki", "search"), mcp("wiki", "add")];
  const held: HeldToolList<T> = { key: "agent|model", tools: offered(before) };

  it("while warm, the approved tool is not offered yet and is listed as waiting", () => {
    const d = resolveToolList({
      live: offered(after),
      held,
      key: "agent|model",
      hold: true,
      nameOf: (t) => t.function.name,
      fingerprintOf: functionFingerprint,
    });
    expect(d.held).toBe(true);
    expect(d.tools.map((t) => t.function.name)).toEqual(["wiki_search"]);
    expect(d.pending.added).toEqual(["wiki_add"]);
  });

  it("once the cache is cold (or the person applies it), it is offered", () => {
    const d = resolveToolList({
      live: offered(after),
      held,
      key: "agent|model",
      hold: false,
      nameOf: (t) => t.function.name,
      fingerprintOf: functionFingerprint,
    });
    expect(d.held).toBe(false);
    expect(d.tools.map((t) => t.function.name)).toEqual([
      "wiki_search",
      "wiki_add",
    ]);
  });
});
