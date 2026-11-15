import { describe, expect, it } from "vitest";

import { Tool } from "../..";
import { assignMcpToolNames } from "../../tools/mcpToolName";

import {
  browserToolCandidate,
  BrowserToolFinding,
  ConfiguredServer,
  findBrowserTool,
  OfferedTool,
} from "./browserTools";

const PLAYWRIGHT_TOOLS = [
  "browser_close",
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_take_screenshot",
];

/** Offered tools as the IDE registers them, names from assignMcpToolNames. */
function ideTools(servers: Record<string, string[]>): OfferedTool[] {
  const items = Object.entries(servers).flatMap(([serverName, tools]) =>
    tools.map((toolName) => ({ serverName, toolName })),
  );
  const names = assignMcpToolNames(items);
  return items.map((item, i) =>
    browserToolCandidate({
      function: { name: names[i] },
      group: item.serverName,
      originalFunctionName: item.toolName,
      uri: `mcp://${encodeURIComponent(item.serverName)}/${item.toolName}`,
    }),
  );
}

const builtIns: OfferedTool[] = [
  { name: "read_file" },
  { name: "fetch_url_content" },
];

// `a` + `b_browser_navigate` and `a_b` + `browser_navigate` both compose to `a_b_browser_navigate`
const COLLIDING = ideTools({
  a: ["b_browser_navigate"],
  a_b: ["browser_navigate", "browser_snapshot"],
});

interface Case {
  name: string;
  offered: OfferedTool[];
  configured?: ConfiguredServer[];
  expected: BrowserToolFinding;
}

const cases: Case[] = [
  {
    name: "a server named playwright",
    offered: [...builtIns, ...ideTools({ playwright: PLAYWRIGHT_TOOLS })],
    expected: {
      kind: "offered",
      server: "playwright",
      navigate: "playwright_browser_navigate",
      snapshot: "playwright_browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "a renamed server",
    offered: ideTools({ "My Browser": PLAYWRIGHT_TOOLS }),
    expected: {
      kind: "offered",
      server: "My Browser",
      navigate: "my_browser_browser_navigate",
      snapshot: "my_browser_browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "colliding names get the registered (suffixed) names",
    offered: COLLIDING,
    expected: {
      kind: "offered",
      server: "a_b",
      navigate: COLLIDING.find(
        (t) => t.server === "a_b" && t.toolName === "browser_navigate",
      )!.name,
      snapshot: "a_b_browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "navigate without snapshot is not a browser",
    offered: ideTools({ fetcher: ["browser_navigate", "fetch"] }),
    expected: { kind: "none" },
  },
  {
    name: "category: web with a navigate tool",
    offered: ideTools({
      puppeteer: ["puppeteer_navigate", "puppeteer_screenshot"],
    }),
    configured: [{ name: "puppeteer", category: "web" }],
    expected: {
      kind: "offered",
      server: "puppeteer",
      navigate: "puppeteer_navigate",
      by: "category",
    },
  },
  {
    name: "category: web with navigate and snapshot",
    offered: ideTools({ chrome: ["navigate", "dom_snapshot", "click"] }),
    configured: [{ name: "chrome", category: " Web " }],
    expected: {
      kind: "offered",
      server: "chrome",
      navigate: "chrome_navigate",
      snapshot: "chrome_dom_snapshot",
      by: "category",
    },
  },
  {
    name: "category: web without a navigate tool (a fetch server) is not a browser",
    offered: ideTools({ fetch: ["fetch"] }),
    configured: [{ name: "fetch", category: "web" }],
    expected: { kind: "none" },
  },
  {
    name: "Playwright names win over category: web",
    offered: ideTools({
      aaa: ["navigate", "snapshot"],
      zzz: PLAYWRIGHT_TOOLS,
    }),
    configured: [{ name: "aaa", category: "web" }],
    expected: {
      kind: "offered",
      server: "zzz",
      navigate: "zzz_browser_navigate",
      snapshot: "zzz_browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "two browsers: the first by server name, whatever the order",
    offered: ideTools({ web2: PLAYWRIGHT_TOOLS, web1: PLAYWRIGHT_TOOLS }),
    expected: {
      kind: "offered",
      server: "web1",
      navigate: expect.stringMatching(/^web1_browser_navigate/) as never,
      snapshot: expect.stringMatching(/^web1_browser_snapshot/) as never,
      by: "tool-names",
    },
  },
  {
    name: "CLI: bare names with the server on the tool",
    offered: PLAYWRIGHT_TOOLS.map((t) => ({
      name: t,
      server: "playwright",
      toolName: t,
    })),
    expected: {
      kind: "offered",
      server: "playwright",
      navigate: "browser_navigate",
      snapshot: "browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "a list with names only: bare",
    offered: [{ name: "browser_navigate" }, { name: "browser_snapshot" }],
    configured: [{ name: "pw", toolNames: PLAYWRIGHT_TOOLS }],
    expected: {
      kind: "offered",
      server: "pw",
      navigate: "browser_navigate",
      snapshot: "browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "a list with names only: qualified",
    offered: [
      { name: "playwright_browser_navigate" },
      { name: "playwright_browser_snapshot" },
    ],
    expected: {
      kind: "offered",
      server: "playwright",
      navigate: "playwright_browser_navigate",
      snapshot: "playwright_browser_snapshot",
      by: "tool-names",
    },
  },
  {
    name: "configured but not offered (turned off, Plan mode)",
    offered: builtIns,
    configured: [
      { name: "github" },
      { name: "playwright", toolNames: PLAYWRIGHT_TOOLS },
    ],
    expected: { kind: "configured", server: "playwright" },
  },
  {
    name: "configured category: web, tools not known",
    offered: builtIns,
    configured: [{ name: "browser", category: "web" }],
    expected: { kind: "configured", server: "browser" },
  },
  {
    name: "configured category: web whose known tools have no navigate",
    offered: builtIns,
    configured: [{ name: "fetch", category: "web", toolNames: ["fetch"] }],
    expected: { kind: "none" },
  },
  {
    name: "an offered non-browser is not 'configured'",
    offered: ideTools({ fetch: ["fetch"] }),
    configured: [{ name: "fetch", category: "web" }],
    expected: { kind: "none" },
  },
  {
    name: "nothing",
    offered: builtIns,
    expected: { kind: "none" },
  },
  {
    name: "a built-in named like a browser tool is ignored when an MCP server has none",
    offered: [{ name: "navigate" }, { name: "snapshot" }],
    expected: { kind: "none" },
  },
];

describe("findBrowserTool", () => {
  it.each(cases)("$name", (c) => {
    expect(findBrowserTool(c.offered, c.configured)).toEqual(c.expected);
  });

  it("does not depend on the order of the offered tools", () => {
    const tools = ideTools({ b: PLAYWRIGHT_TOOLS, a: PLAYWRIGHT_TOOLS });
    const forward = JSON.stringify(findBrowserTool(tools));
    const backward = JSON.stringify(findBrowserTool([...tools].reverse()));
    expect(backward).toBe(forward);
  });
});

describe("browserToolCandidate", () => {
  it("reads an IDE MCP tool", () => {
    const tool: Pick<
      Tool,
      "function" | "group" | "originalFunctionName" | "uri"
    > = {
      function: { name: "playwright_browser_navigate" },
      group: "playwright",
      originalFunctionName: "browser_navigate",
      uri: "mcp://playwright/browser_navigate",
    };
    expect(browserToolCandidate(tool)).toEqual({
      name: "playwright_browser_navigate",
      server: "playwright",
      toolName: "browser_navigate",
    });
  });

  it("a built-in has no server", () => {
    expect(
      browserToolCandidate({
        function: { name: "fetch_url_content" },
        group: "Built-In",
      }),
    ).toEqual({ name: "fetch_url_content" });
  });
});
