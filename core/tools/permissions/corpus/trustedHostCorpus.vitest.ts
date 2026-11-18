import { describe, expect, it } from "vitest";
import { testToolCall } from "../testToolCall";
import { ROWS } from "./corpusRows";

/**
 * ROADMAP B56 on the 287 labelled calls: at Automatic, the calls the trusted-host
 * allow settles, and whether any of them is labelled ask or deny.
 */
describe("trusted-host allow on the 287 labelled calls", () => {
  const settled = ROWS.filter((row) => {
    const r = testToolCall({
      tool: row.tool,
      args: row.args,
      levels: {
        context: "automatic",
        tools: "automatic",
        edits: "automatic",
        plan: "automatic",
        questions: "automatic",
      },
      sources: {
        user: { auto: { environment: { trustedDomains: row.trusted } } },
        builtin: { "ask-outside-paths": false },
      },
      cwd: "/home/dev/shop",
      shell: "bash",
    });
    return r.source === "trusted-host";
  });

  it("covers all 287 calls", () => {
    expect(ROWS.length).toBe(287);
  });

  it("turns no call labelled ask or deny into an allow", () => {
    expect(
      settled.filter((r) => r.expect !== "allow").map((r) => r.id),
    ).toEqual([]);
  });

  it("settles the calls it settles (count pinned)", () => {
    expect(settled.length).toBe(SETTLED);
  });
});

const SETTLED = 5;
