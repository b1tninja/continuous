/**
 * TR4 in the CLI: a new or changed MCP tool is not offered until the person
 * approves it (`/mcp approve`), and an unattended run (headless, a Loop
 * worker) gets only the MCP tools listed in `background.mcpTools`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  approveTools,
  recordApproval,
  setToolPinStore,
} from "core/context/mcp/mcpToolPins.js";
import { MemoryToolPinStore } from "core/context/mcp/toolPinning.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPolicyFile,
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import { handleSlashCommands } from "../slashCommands.js";
import {
  cliRoleRefusal,
  filterCliToolsForRole,
  setCliUnattended,
} from "../tools/roleGate.js";

import { MCPService } from "./MCPService.js";

import { services } from "./index.js";

const tool = (name: string, description = `Does ${name}`) => ({
  name,
  description,
  inputSchema: { type: "object" as const, properties: {} },
});

const connectionFor = (tools = [tool("search"), tool("add")]) =>
  ({
    config: { name: "docs", command: "npx", args: ["docs-mcp"] },
    client: null,
    status: "connected",
    tools,
    prompts: [],
    warnings: [],
  }) as any;

/** The CLI tool the request would carry for one MCP tool of `docs`. */
const cliTool = (svc: MCPService, name: string) => {
  const pending = svc.getPendingApproval("docs", name);
  return {
    name,
    isBuiltIn: false,
    mcpServer: "docs",
    mcpToolName: name,
    description: "",
    displayName: name,
    parameters: { type: "object" as const, properties: {} },
    run: async () => "",
    ...(pending ? { mcpPendingApproval: pending } : {}),
  } as any;
};

const offered = (svc: MCPService, mode = "normal") =>
  filterCliToolsForRole(mode, [
    { name: "Read", isBuiltIn: true } as any,
    cliTool(svc, "search"),
    cliTool(svc, "add"),
  ]).map((t) => t.name);

let store: MemoryToolPinStore;
let dir: string;

beforeEach(() => {
  store = new MemoryToolPinStore();
  setToolPinStore(store);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-mcp-approval-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetPolicyLevels();
  setCliUnattended(false);
});
afterEach(() => {
  setToolPinStore(undefined);
  setCliUnattended(false);
  resetPolicyLevels();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function serviceWith(c: any): Promise<MCPService> {
  const svc = new MCPService();
  (svc as any).connections.set("docs", c);
  await svc.refreshPins(c);
  return svc;
}

describe("a new MCP tool is hidden until approved", () => {
  it("a server never approved: none of its tools is offered", async () => {
    const svc = await serviceWith(connectionFor());
    expect(svc.getPendingApproval("docs", "search")).toBe("new");
    expect(offered(svc)).toEqual(["Read"]);
    expect(cliRoleRefusal("normal", cliTool(svc, "search"))).toMatch(
      /has not approved it yet/,
    );
  });

  it("/mcp pending lists them, /mcp approve offers the one named", async () => {
    const svc = await serviceWith(connectionFor());
    const original = services.mcp;
    (services as any).mcp = svc;
    try {
      const list = await handleSlashCommands("/mcp pending", {} as never);
      expect(list?.output).toContain("docs/search: Does search");
      expect(list?.output).toContain("docs/add");
      const r = await handleSlashCommands(
        "/mcp approve docs search",
        {} as never,
      );
      expect(r?.output).toMatch(/^Approved search on docs\./);
      expect(r?.output).toContain("prompt cache goes cold");
      expect(offered(svc)).toEqual(["Read", "search"]);
      await handleSlashCommands("/mcp approve docs", {} as never);
      expect(offered(svc)).toEqual(["Read", "search", "add"]);
      expect(
        (await handleSlashCommands("/mcp pending", {} as never))?.output,
      ).toBe("No MCP tool is waiting for approval.");
    } finally {
      (services as any).mcp = original;
    }
  });

  it("a tool the server adds after approval waits again", async () => {
    await approveTools("docs", [tool("search")], store, "all");
    const svc = await serviceWith(connectionFor());
    expect(svc.getPendingApproval("docs", "add")).toBe("added");
    expect(offered(svc)).toEqual(["Read", "search"]);
  });

  it("IDGAF offers them (the first call pins)", async () => {
    const svc = await serviceWith(connectionFor());
    setPolicyLevels({
      context: "idgaf",
      tools: "idgaf",
      edits: "idgaf",
      plan: "idgaf",
      questions: "idgaf",
    });
    expect(offered(svc)).toEqual(["Read", "search", "add"]);
    expect(offered(svc, "auto")).toEqual(["Read", "search", "add"]);
  });

  it("upgrade: a server an earlier version pinned keeps all its tools", async () => {
    // 2.16.x pinned the whole server on its first approved call
    await recordApproval(
      "docs",
      [tool("search"), tool("add")],
      store,
      "search",
    );
    const svc = await serviceWith(connectionFor());
    expect(offered(svc)).toEqual(["Read", "search", "add"]);
  });
});

describe("unattended runs get no MCP tools unless listed (background.mcpTools)", () => {
  it("none by default, even approved ones", async () => {
    await approveTools("docs", [tool("search"), tool("add")], store, "all");
    const svc = await serviceWith(connectionFor());
    setCliUnattended(true);
    expect(offered(svc)).toEqual(["Read"]);
    expect(cliRoleRefusal("normal", cliTool(svc, "search"))).toContain(
      "background.mcpTools",
    );
  });

  it("the listed ones, and a listed tool of a never-approved server pins only itself", async () => {
    const file = path.join(dir, "permissions.yaml");
    fs.writeFileSync(file, "background:\n  mcpTools:\n    - docs/search\n");
    expect(loadPolicyFile(file)).toEqual([]);
    const c = connectionFor();
    const svc = await serviceWith(c);
    setCliUnattended(true);
    svc.isUnattended = () => true;
    expect(offered(svc)).toEqual(["Read", "search"]);
    await svc.recordPins(c, "search");
    expect(Object.keys((await store.get("docs"))!.tools)).toEqual(["search"]);
    // `add` was not approved by that call: back in the terminal UI it waits
    setCliUnattended(false);
    expect(svc.getPendingApproval("docs", "add")).toBe("added");
    expect(offered(svc)).toEqual(["Read", "search"]);
  });
});
