import { describe, expect, it } from "vitest";

import { parseMcpPaste } from "./parseMcpPaste";

/*
  What the dialog's "Paste a command, a URL, or a JSON snippet" box makes of
  each kind of input. One row per kind; parseMcpPaste.vitest.ts has the
  corner cases of each format.
*/

/** The parts of a candidate the form shows. */
function seen(text: string) {
  return parseMcpPaste(text).candidates.map((c) => ({
    name: c.name,
    transport: c.transport,
    ...(c.command === undefined ? {} : { command: c.command, args: c.args }),
    ...(c.url === undefined ? {} : { url: c.url }),
    ...(c.env.length ? { env: c.env.map((e) => e.name) } : {}),
    ...(c.headers.length ? { headers: c.headers.map((h) => h.name) } : {}),
  }));
}

describe("the paste box: command lines", () => {
  it.each([
    [
      "npx -y @modelcontextprotocol/server-filesystem /path",
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      },
    ],
    [
      "uvx mcp-server-git",
      {
        name: "git",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-git"],
      },
    ],
    [
      "docker run -i --rm mcp/fetch",
      {
        name: "fetch",
        transport: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", "mcp/fetch"],
      },
    ],
  ])("%s", (text, expected) => {
    expect(seen(text)).toEqual([expected]);
  });

  it("keeps a quoted argument with spaces as one argument", () => {
    expect(
      seen(
        `npx -y @modelcontextprotocol/server-filesystem "/home/me/My Notes"`,
      ),
    ).toEqual([
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/me/My Notes",
        ],
      },
    ]);
  });

  it("keeps the backslashes of a Windows path, quoted or not", () => {
    expect(
      seen(
        String.raw`npx -y @modelcontextprotocol/server-filesystem "C:\Users\Me\My Projects" D:\code`,
      )[0].args,
    ).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      String.raw`C:\Users\Me\My Projects`,
      String.raw`D:\code`,
    ]);
  });

  it("keeps a `--` separator among the arguments", () => {
    expect(seen("node server.js -- --flag value")[0].args).toEqual([
      "server.js",
      "--",
      "--flag",
      "value",
    ]);
  });

  it("reads KEY=value before the command as environment variables", () => {
    const [c] = parseMcpPaste(
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 LOG_LEVEL=debug npx -y @modelcontextprotocol/server-github",
    ).candidates;
    expect(c.command).toBe("npx");
    expect(c.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(
      c.env.map((e) => [e.name, e.secretLooking, e.value !== undefined]),
    ).toEqual([
      ["GITHUB_TOKEN", true, true],
      ["LOG_LEVEL", false, true],
    ]);
  });

  it("reads nothing from text that is not a command", () => {
    expect(seen("hello world this is not a command")).toEqual([]);
    expect(seen("")).toEqual([]);
  });
});

describe("the paste box: URLs", () => {
  it("takes an /mcp address as Streamable HTTP, as a guess", () => {
    const [c] = parseMcpPaste("https://example.com/mcp").candidates;
    expect([c.name, c.transport, c.transportGuessed, c.url]).toEqual([
      "example",
      "http",
      true,
      "https://example.com/mcp",
    ]);
  });

  it("takes an /sse address as SSE, as a guess", () => {
    const [c] = parseMcpPaste("https://example.com/sse").candidates;
    expect([c.transport, c.transportGuessed]).toEqual(["sse", true]);
  });
});

describe("the paste box: JSON from other tools", () => {
  it("reads every server of a Claude Desktop, Cursor or Cline block", () => {
    expect(
      seen(
        `{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "server-fs", "/tmp"], "env": {"A": "1"}}, "git": {"command": "uvx", "args": ["mcp-server-git"]}}}`,
      ),
    ).toEqual([
      {
        name: "fs",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server-fs", "/tmp"],
        env: ["A"],
      },
      {
        name: "git",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-git"],
      },
    ]);
  });

  it("reads VS Code's servers form with its three types", () => {
    const text = JSON.stringify({
      servers: {
        gh: {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ${input:token}" },
        },
        loc: { type: "stdio", command: "node", args: ["server.js"] },
        old: { type: "sse", url: "https://x.example/sse" },
      },
    });
    expect(seen(text)).toEqual([
      {
        name: "gh",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: ["Authorization"],
      },
      {
        name: "loc",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
      },
      { name: "old", transport: "sse", url: "https://x.example/sse" },
    ]);
    // Another tool's variable is not a value: the form asks for one
    const auth = parseMcpPaste(text).candidates[0].headers[0];
    expect(auth.value).toBeUndefined();
    expect(auth.reference).toEqual({ kind: "vscode-input", name: "token" });
  });

  it("reads one inner server object, with a Windows path", () => {
    const text = JSON.stringify({
      command: "node",
      args: [String.raw`C:\tools\server.js`],
    });
    const [c] = parseMcpPaste(text).candidates;
    expect(c.command).toBe("node");
    expect(c.args).toEqual([String.raw`C:\tools\server.js`]);
    expect(c.nameGuessed).toBe(true);
  });

  it("says so when the JSON does not parse", () => {
    const r = parseMcpPaste(`{"mcpServers": {"a": {"command": "npx",}`);
    expect(r.candidates).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/does not parse/);
  });
});

describe("the paste box: claude mcp add", () => {
  it("reads the name, the -e variables and the command after --", () => {
    const [c] = parseMcpPaste(
      "claude mcp add github -e GITHUB_TOKEN=YOUR_TOKEN -- npx -y @modelcontextprotocol/server-github",
    ).candidates;
    expect([c.name, c.command, c.args]).toEqual([
      "github",
      "npx",
      ["-y", "@modelcontextprotocol/server-github"],
    ]);
    // An example value is not kept as the value
    expect(c.env[0]).toMatchObject({ name: "GITHUB_TOKEN", placeholder: true });
  });

  it("reads --transport http and sse with a URL and headers", () => {
    expect(
      seen("claude mcp add --transport http sentry https://mcp.sentry.dev/mcp"),
    ).toEqual([
      { name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" },
    ]);
    expect(
      seen(
        `claude mcp add --transport sse linear https://mcp.linear.app/sse --header "Authorization: Bearer abc"`,
      ),
    ).toEqual([
      {
        name: "linear",
        transport: "sse",
        url: "https://mcp.linear.app/sse",
        headers: ["Authorization"],
      },
    ]);
  });
});
