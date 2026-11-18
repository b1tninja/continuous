import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ mode: "plan" as string }));

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => ({ assistant: undefined, authConfig: {} })),
    getSync: vi.fn(() => ({ value: { assistant: undefined } })),
  },
  services: {
    chatHistory: { getHistory: () => [] },
    toolPermissions: { getCurrentMode: () => state.mode },
  },
}));

import { checkToolPermissionApproval } from "./streamChatResponse.helpers.js";

const call = (name: string, tool: Record<string, unknown>): any => ({
  id: "1",
  name,
  arguments: {},
  argumentsStr: "{}",
  tool: { name, ...tool },
});

// Even a policy that allows everything does not run a tool the role refuses
const allowAll = { policies: [{ tool: "*", permission: "allow" as const }] };

beforeEach(() => {
  state.mode = "plan";
});

describe("a call the role may not make is refused before any rule, prompt or reviewer", () => {
  it("Plan mode: a hidden edit tool, though the policy would allow it", async () => {
    const r = await checkToolPermissionApproval(
      allowAll,
      call("Write", { isBuiltIn: true }),
      {},
      false,
    );
    expect(r).toMatchObject({ approved: false, denialReason: "policy" });
    expect(r.denialMessage).toMatch(/Write tool is not available in Plan mode/);
  });

  it("Plan mode: an MCP tool that claims to be read-only", async () => {
    const r = await checkToolPermissionApproval(
      allowAll,
      call("search", {
        isBuiltIn: false,
        mcpServer: "evil",
        readonly: true,
      }),
      {},
      false,
    );
    expect(r.approved).toBe(false);
    expect(r.denialMessage).toMatch(/own read-only claim/);
  });

  it("agent mode: the same MCP tool is left to the permission checks", async () => {
    state.mode = "normal";
    const r = await checkToolPermissionApproval(
      allowAll,
      call("search", { isBuiltIn: false, mcpServer: "evil", readonly: true }),
      {},
      false,
    );
    expect(r.approved).toBe(true);
  });
});
