import fs from "fs";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { checkToolPermission } from "../permissions/permissionChecker.js";
import { PERMISSIONS_YAML_PATH } from "../permissions/permissionsYamlLoader.js";
import type { ToolPermissions } from "../permissions/types.js";

import { ToolPermissionService } from "./ToolPermissionService.js";
import type { AgentFileServiceState } from "./types.js";

// An agent file (a hub slug or a repository .md) may take tools away from
// the person's policy; it may not widen it (plans/research CO4).

const agentFile = (
  tools: { toolName: string }[] | null,
): AgentFileServiceState => ({
  agentFile: { name: "third-party-agent" } as any,
  slug: "someone/agent",
  agentFileModel: null,
  parsedTools: tools ? { mcpServers: [], tools, allBuiltIn: false } : null,
  parsedRules: null,
});

const decide = (permissions: ToolPermissions, name: string, args = {}) =>
  checkToolPermission({ name, arguments: args }, permissions).permission;

function writePermissionsYaml(text: string) {
  fs.mkdirSync(path.dirname(PERMISSIONS_YAML_PATH), {
    recursive: true,
  });
  fs.writeFileSync(PERMISSIONS_YAML_PATH, text);
}

afterEach(() => {
  fs.rmSync(PERMISSIONS_YAML_PATH, { force: true });
});

describe("an --agent file narrows the person's policy and never widens it", () => {
  it("interactive: Bash listed by the agent file still asks, as it would without the file", () => {
    const state = new ToolPermissionService().initializeSync(
      { isHeadless: false },
      agentFile([{ toolName: "Bash" }, { toolName: "Read" }]),
    );
    expect(decide(state.permissions, "Bash", { command: "ls" })).toBe("ask");
    expect(decide(state.permissions, "Read")).toBe("allow");
    // Left out of the agent file: taken away
    expect(decide(state.permissions, "Write")).toBe("exclude");
    expect(decide(state.permissions, "Fetch")).toBe("exclude");
  });

  it("no trailing allow: an unlisted (MCP) tool asks in the terminal UI", () => {
    for (const tools of [null, [{ toolName: "Bash" }]]) {
      const state = new ToolPermissionService().initializeSync(
        { isHeadless: false },
        agentFile(tools),
      );
      expect(decide(state.permissions, "some_mcp_tool")).toBe("ask");
    }
  });

  it("the person's permissions.yaml ask and exclude lists still bind", () => {
    writePermissionsYaml(
      ["ask:", "  - Read", "exclude:", "  - Fetch", ""].join("\n"),
    );
    const state = new ToolPermissionService().initializeSync(
      { isHeadless: true },
      agentFile([{ toolName: "Read" }, { toolName: "Fetch" }]),
    );
    expect(decide(state.permissions, "Read")).toBe("ask");
    expect(decide(state.permissions, "Fetch")).toBe("exclude");
  });

  it("the person's --ask and --exclude flags still bind", () => {
    const state = new ToolPermissionService().initializeSync(
      { isHeadless: false, ask: ["Read"], exclude: ["Search"] },
      agentFile([{ toolName: "Read" }, { toolName: "Search" }]),
    );
    expect(decide(state.permissions, "Read")).toBe("ask");
    expect(decide(state.permissions, "Search")).toBe("exclude");
  });

  it("the agent file's exclude wins over the person's allow", () => {
    const state = new ToolPermissionService().initializeSync(
      { isHeadless: false, allow: ["Write"] },
      agentFile([{ toolName: "Read" }]),
    );
    expect(decide(state.permissions, "Write")).toBe("exclude");
  });

  it("headless keeps the headless list defaults, unchanged by this (CO2 is separate)", () => {
    const state = new ToolPermissionService().initializeSync(
      { isHeadless: true },
      agentFile([{ toolName: "Bash" }]),
    );
    const without = new ToolPermissionService().initializeSync(
      { isHeadless: true },
      undefined,
    );
    expect(decide(state.permissions, "Bash", { command: "ls" })).toBe(
      decide(without.permissions, "Bash", { command: "ls" }),
    );
    expect(decide(state.permissions, "Read")).toBe("exclude");
  });

  it("plan mode applies under an agent file, and the file's excludes stay", () => {
    const service = new ToolPermissionService();
    const state = service.initializeSync(
      { isHeadless: false, mode: "plan" },
      agentFile([{ toolName: "Bash" }, { toolName: "Edit" }]),
    );
    // Plan mode excludes edits even though the agent file lists Edit
    expect(decide(state.permissions, "Edit")).toBe("exclude");
    expect(decide(state.permissions, "Bash", { command: "ls" })).toBe("ask");
    expect(decide(state.permissions, "Read")).toBe("exclude");

    const normal = service.switchMode("normal");
    expect(decide(normal.permissions, "Read")).toBe("exclude");
    expect(decide(normal.permissions, "Edit")).toBe("ask");
  });

  it("switching to auto and back, and a reload, keep the file's excludes", async () => {
    const service = new ToolPermissionService();
    service.initializeSync(
      { isHeadless: false },
      agentFile([{ toolName: "Read" }]),
    );
    const auto = service.switchMode("auto");
    expect(decide(auto.permissions, "Bash", { command: "ls" })).toBe("exclude");
    expect(decide(auto.permissions, "Read")).toBe("allow");
    const back = service.switchMode("normal");
    expect(decide(back.permissions, "Bash", { command: "ls" })).toBe("exclude");
    await service.reloadPermissions();
    expect(decide(service.getPermissions(), "Bash", { command: "ls" })).toBe(
      "exclude",
    );
    expect(decide(service.getPermissions(), "Read")).toBe("allow");
  });

  it("without an agent file nothing changes", () => {
    const state = new ToolPermissionService().initializeSync(
      { isHeadless: false },
      undefined,
    );
    expect(state.agentFilePolicies).toBeUndefined();
    expect(decide(state.permissions, "Bash", { command: "ls" })).toBe("ask");
    expect(decide(state.permissions, "Write")).toBe("ask");
  });
});
