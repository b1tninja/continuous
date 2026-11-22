import { describe, expect, it } from "vitest";

import { convertYamlMcpConfigToInternalMcpOptions } from "../../config/yaml/yamlToContinueConfig";

import {
  DEFAULT_MCP_TOOL_TIMEOUT,
  mcpToolCallTimeout,
  resolveMcpToolTimeout,
} from "./mcpTimeouts";

describe("the limit of one MCP tool call", () => {
  it("is 60 seconds when neither timeout is set", () => {
    expect(DEFAULT_MCP_TOOL_TIMEOUT).toBe(60_000);
    expect(resolveMcpToolTimeout({})).toEqual({
      ms: 60_000,
      from: "built-in",
    });
  });

  it("still follows a connection timeout when no tool timeout is set, as before the key existed", () => {
    expect(resolveMcpToolTimeout({ timeout: 120_000 })).toEqual({
      ms: 120_000,
      from: "connectionTimeout",
    });
    // A short one too: nothing changes for a config written before
    expect(mcpToolCallTimeout({ timeout: 5_000 })).toBe(5_000);
  });

  it("is the tool timeout when that is set, whatever the connection timeout", () => {
    expect(
      resolveMcpToolTimeout({ timeout: 5_000, toolTimeout: 300_000 }),
    ).toEqual({ ms: 300_000, from: "toolTimeout" });
    expect(mcpToolCallTimeout({ timeout: 120_000, toolTimeout: 10_000 })).toBe(
      10_000,
    );
    expect(mcpToolCallTimeout({ toolTimeout: 90_000 })).toBe(90_000);
  });

  it("reads both keys of a config entry, in milliseconds", () => {
    const stdio = convertYamlMcpConfigToInternalMcpOptions({
      name: "a",
      command: "npx",
      connectionTimeout: 30_000,
      toolTimeout: 180_000,
    });
    expect([stdio.timeout, stdio.toolTimeout]).toEqual([30_000, 180_000]);
    expect(mcpToolCallTimeout(stdio)).toBe(180_000);

    const remote = convertYamlMcpConfigToInternalMcpOptions({
      name: "b",
      url: "https://b.example/mcp",
      toolTimeout: 45_000,
    });
    expect([remote.timeout, remote.toolTimeout]).toEqual([undefined, 45_000]);

    const neither = convertYamlMcpConfigToInternalMcpOptions({
      name: "c",
      command: "npx",
    });
    expect(mcpToolCallTimeout(neither)).toBe(60_000);
  });
});
