import { describe, expect, it, vi } from "vitest";

import { MCPService } from "./MCPService.js";

// A service with two connected servers that both offer `search`
function twoServers() {
  const service = new MCPService();
  const calls: string[] = [];
  const connection = (name: string, tools: string[]) => ({
    status: "connected",
    config: { name },
    tools: tools.map((t) => ({ name: t, inputSchema: { type: "object" } })),
    prompts: [],
    warnings: [],
    client: {
      callTool: vi.fn(async ({ name: tool }: { name: string }) => {
        calls.push(`${name}/${tool}`);
        return { content: [{ type: "text", text: name }] };
      }),
    },
  });
  const map = (service as any).connections as Map<string, unknown>;
  map.set("first", connection("first", ["search", "only_first"]));
  map.set("second", connection("second", ["search"]));
  // pins and token refresh are not what these tests are about
  (service as any).recordPins = async () => {};
  (service as any).withTokenRefresh = async (_: string, fn: () => unknown) =>
    fn();
  return { service, calls };
}

describe("MCPService.runTool routing (TR23)", () => {
  it("runs on exactly the server named, even when it connected second", async () => {
    const { service, calls } = twoServers();
    const result = await service.runTool("search", {}, "second");
    expect(calls).toEqual(["second/search"]);
    expect(result.content).toEqual([{ type: "text", text: "second" }]);
  });

  it("runs on the first server when that is the one named", async () => {
    const { service, calls } = twoServers();
    await service.runTool("search", {}, "first");
    expect(calls).toEqual(["first/search"]);
  });

  it("refuses a bare name two servers offer, and runs nothing", async () => {
    const { service, calls } = twoServers();
    await expect(service.runTool("search", {})).rejects.toThrow(
      /more than one MCP server \(first, second\)/,
    );
    expect(calls).toEqual([]);
  });

  it("a bare name only one server offers still runs, as before", async () => {
    const { service, calls } = twoServers();
    await service.runTool("only_first", {});
    expect(calls).toEqual(["first/only_first"]);
  });

  it("does not fall through to another server when the named one lacks the tool", async () => {
    const { service, calls } = twoServers();
    await expect(service.runTool("only_first", {}, "second")).rejects.toThrow(
      "Tool only_first not found",
    );
    expect(calls).toEqual([]);
  });
});
