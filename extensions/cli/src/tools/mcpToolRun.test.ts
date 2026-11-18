import { beforeEach, describe, expect, it, vi } from "vitest";

const runTool = vi.hoisted(() => vi.fn(async () => ({ content: "ok" })));
vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: {},
  serviceContainer: {},
  services: { mcp: { runTool } },
}));

import { convertMcpToolToContinueTool } from "./index.js";

const mcpTool = (serverName: string) => ({
  name: "search",
  serverName,
  inputSchema: { type: "object" as const, properties: {} },
});

describe("an MCP tool runs on the server it was listed under (TR23)", () => {
  beforeEach(() => runTool.mockClear());

  it("passes its own server, never just the name", async () => {
    const wiki = convertMcpToolToContinueTool(mcpTool("wiki"), "wiki_search");
    const docs = convertMcpToolToContinueTool(mcpTool("docs"), "docs_search");
    await wiki.run({ q: 1 });
    await docs.run({ q: 2 });
    expect(runTool).toHaveBeenNthCalledWith(1, "search", { q: 1 }, "wiki");
    expect(runTool).toHaveBeenNthCalledWith(2, "search", { q: 2 }, "docs");
  });
});
