import { describe, expect, it } from "vitest";

import type { McpProbeResult } from "./probeMcpServer";
import { describeProbe, httpStatusIn } from "./probeOutcome";

const base = (over: Partial<McpProbeResult> = {}): McpProbeResult => ({
  ok: false,
  status: "error",
  durationMs: 1234,
  timeoutMs: 20_000,
  transport: "stdio",
  tools: [],
  resources: [],
  prompts: [],
  errors: [],
  infos: [],
  stderr: { lines: [], truncated: false },
  hints: [],
  needsSignIn: false,
  notice: "",
  ...over,
});

const tool = (name: string, instructionLike: string[] = []) => ({
  name,
  description: "",
  truncated: false,
  instructionLike,
});

describe("describeProbe", () => {
  it("says connected, with the server's own name, version and counts", () => {
    const o = describeProbe({
      ran: true,
      result: base({
        ok: true,
        status: "connected",
        server: { name: "github-mcp", version: "1.4.0" },
        tools: [tool("search_issues"), tool("create_issue")],
        prompts: [{ name: "triage", description: "" }],
      }),
    });
    expect(o.tone).toBe("success");
    expect(o.headline).toBe("Connected in 1.2 seconds.");
    expect(o.server).toBe("github-mcp 1.4.0");
    expect(o.counts).toEqual({ tools: 2, prompts: 1, resources: 0 });
    expect(o.toolNames).toEqual(["search_issues", "create_issue"]);
  });

  it("warns about a tool whose description reads like instructions", () => {
    const o = describeProbe({
      ran: true,
      result: base({
        ok: true,
        status: "connected",
        tools: [tool("ok"), tool("odd", ["ignore previous instructions"])],
      }),
    });
    expect(o.tone).toBe("warning");
    expect(o.flaggedTools).toEqual(["odd"]);
    expect(o.details.join(" ")).toContain("odd");
  });

  it("names the command that was not found and the PATH that was searched", () => {
    const o = describeProbe(
      {
        ran: true,
        result: base({
          errors: ["spawn uvx ENOENT"],
          hints: [
            {
              code: "install-uv",
              text: "`uvx` was not found. Install uv, then restart your editor so the PATH is refreshed.",
              link: "https://docs.astral.sh/uv/getting-started/installation/",
            },
          ],
          pathSearched: ["C:\\Windows", "C:\\Program Files\\nodejs"],
        }),
      },
      { command: "uvx" },
    );
    expect(o.tone).toBe("error");
    expect(o.headline).toBe("Command not found: uvx");
    expect(o.details[0]).toBe(
      "Looked in the 2 folders of the PATH the editor has: C:\\Windows, C:\\Program Files\\nodejs",
    );
    expect(o.details[1]).toMatch(/Install uv/);
    expect(o.links).toEqual([
      {
        text: "How to install it",
        href: "https://docs.astral.sh/uv/getting-started/installation/",
      },
    ]);
  });

  it("does not claim a PATH when none is known", () => {
    const o = describeProbe(
      {
        ran: true,
        result: base({
          hints: [{ code: "command-not-found", text: "`foo` was not found." }],
        }),
      },
      { command: "foo" },
    );
    expect(o.details.join(" ")).not.toMatch(/Looked in/);
  });

  it("says how long it waited when it timed out", () => {
    const o = describeProbe({
      ran: true,
      result: base({ status: "timeout", timeoutMs: 45_000 }),
    });
    expect(o.headline).toBe("Timed out after 45 seconds.");
  });

  it("explains an HTTP status", () => {
    const o = describeProbe({
      ran: true,
      result: base({
        transport: "http",
        errors: ["Error POSTing to endpoint (HTTP 404): Not Found"],
      }),
    });
    expect(o.headline).toBe(
      "The server answered HTTP 404: nothing answers at this address, so check the URL.",
    );
    expect(o.details).toContain(
      "Error POSTing to endpoint (HTTP 404): Not Found",
    );
  });

  it("gives a status it has no words for as the number alone", () => {
    expect(
      describeProbe({
        ran: true,
        result: base({ transport: "http", errors: ["HTTP 418"] }),
      }).headline,
    ).toBe("The server answered HTTP 418.");
  });

  it("says a key or sign-in is needed before quoting a 401", () => {
    const o = describeProbe({
      ran: true,
      result: base({
        transport: "http",
        needsSignIn: true,
        errors: ["HTTP 401"],
        hints: [
          {
            code: "needs-key",
            text: "This server needs a key. Add a header such as Authorization.",
          },
        ],
      }),
    });
    expect(o.headline).toBe(
      "The server answered, and it needs a key or a sign-in.",
    );
    expect(o.details[0]).toMatch(/needs a key/);
  });

  it("shows the last output of a local server that stopped", () => {
    const o = describeProbe({
      ran: true,
      result: base({
        errors: ["Connection closed"],
        stderr: { lines: ["Error: missing GITHUB_TOKEN"], truncated: false },
        hints: [
          {
            code: "exited",
            text: "The server stopped before it answered. Its last output is shown below.",
          },
        ],
      }),
    });
    expect(o.headline).toBe("The server started but did not connect.");
    expect(o.stderr).toEqual(["Error: missing GITHUB_TOKEN"]);
  });

  it("passes on why nothing was run", () => {
    const untrusted = describeProbe({
      ran: false,
      reason: "untrusted",
      error: "Not tested: this folder's MCP servers are not trusted yet.",
    });
    expect(untrusted.tone).toBe("warning");
    expect(untrusted.headline).toMatch(/not trusted/);
    const missing = describeProbe({
      ran: false,
      reason: "missing-values",
      error: "Not tested: GITHUB_TOKEN has no value yet.",
      missing: ["GITHUB_TOKEN"],
    });
    expect(missing.tone).toBe("error");
    expect(missing.details).toEqual(["Fill in: GITHUB_TOKEN."]);
  });
});

describe("httpStatusIn", () => {
  it.each([
    ["Error POSTing to endpoint (HTTP 502): Bad Gateway", 502],
    ["Request failed with status code 403", 403],
    ["SSE error: Non-200 status code (404)", 404],
    ["spawn npx ENOENT", undefined],
    ["listening on port 200", undefined],
  ])("%s", (text, status) => {
    expect(httpStatusIn([text])).toBe(status);
  });
});
