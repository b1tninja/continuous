import { describe, expect, test } from "vitest";

import {
  inlineMcpServerNames,
  mcpServerIsTrusted,
  mcpToolIsReadOnly,
  type McpTrustContext,
} from "../../context/mcp/mcpTrust";
import { sinkOfCall } from "../../tools/permissions/taint/taintSinks";

const ctx: McpTrustContext = {
  workspaceDirs: ["file:///repo"],
  trustedServers: ["listed"],
  userConfigServers: new Set(["mine"]),
  globalDir: "file:///home/me/.continue",
};
const readOnly = { annotations: { readOnlyHint: true } };

const believed = (server: { name: string; sourceFile?: string }) =>
  mcpToolIsReadOnly(readOnly, server, ctx);

describe("believing an MCP tool's read-only mark (TR22)", () => {
  test("from a server the person trusts", () => {
    // listed in permissions.yaml
    expect(believed({ name: "listed" })).toBe(true);
    // written inline in their own config.yaml
    expect(believed({ name: "mine" })).toBe(true);
    // defined by a file in their global folder
    expect(
      believed({
        name: "g",
        sourceFile: "file:///home/me/.continue/mcpServers/g.yaml",
      }),
    ).toBe(true);
  });

  test("not from a server the open repository brought", () => {
    const sourceFile = "file:///repo/.continue/mcpServers/a.yaml";
    expect(believed({ name: "a", sourceFile })).toBe(false);
    // not even under a name the person listed
    expect(believed({ name: "listed", sourceFile })).toBe(false);
    expect(believed({ name: "mine", sourceFile })).toBe(false);
  });

  test("not from a server of unknown origin", () => {
    // a hub assistant, a flag or an agent file leaves no source file
    expect(believed({ name: "stranger" })).toBe(false);
    expect(
      believed({ name: "elsewhere", sourceFile: "file:///opt/other/x.yaml" }),
    ).toBe(false);
  });

  test("a tool with no mark, or a false one, is never read-only", () => {
    expect(mcpToolIsReadOnly({}, { name: "listed" }, ctx)).toBe(false);
    expect(
      mcpToolIsReadOnly(
        { annotations: { readOnlyHint: false } },
        { name: "listed" },
        ctx,
      ),
    ).toBe(false);
  });

  test("the server check alone", () => {
    expect(mcpServerIsTrusted({ name: "listed" }, ctx)).toBe(true);
    expect(mcpServerIsTrusted({ name: "stranger" }, ctx)).toBe(false);
  });

  test("a name written inline in config.yaml, not one it only references", () => {
    const names = inlineMcpServerNames(
      [
        "mcpServers:",
        "  - name: docs",
        "    command: docs-mcp",
        "  - uses: someone/hub-server",
        "  - name: sneaky",
        "    uses: someone/other",
        "",
      ].join("\n"),
    );
    expect([...names]).toEqual(["docs"]);
    expect(inlineMcpServerNames(": : not yaml [").size).toBe(0);
  });
});

describe("the tainted-session rule follows the same trust", () => {
  const sink = (tool: { readonly?: boolean; mcpFromWorkspace?: boolean }) =>
    sinkOfCall({
      toolName: "x_send",
      parsedArgs: {},
      tool: { uri: "mcp://x/send", originalFunctionName: "send", ...tool },
    })?.class;

  test("a tool believed read-only is not a sink", () => {
    expect(sink({ readonly: true })).toBeUndefined();
  });

  test("an untrusted server's tool (readonly unset) is a sink", () => {
    expect(sink({ readonly: undefined })).toBe("mcp-send");
    expect(sink({ readonly: false })).toBe("mcp-send");
  });

  test("a workspace server's hint never clears the sink", () => {
    expect(sink({ readonly: true, mcpFromWorkspace: true })).toBe("mcp-send");
  });
});
