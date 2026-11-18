import { describe, expect, it } from "vitest";
import { allowOutsideWorkspaceOf, outsideEditNote } from "./outsideEdits";

const stateWith = (edits: string, tools = "cautious") =>
  ({
    ui: {
      policyLevels: {
        context: "cautious",
        tools,
        edits,
        plan: "cautious",
        questions: "cautious",
      },
      policyExtras: {},
    },
    config: { config: { experimental: {}, selectedModelByRole: {} } },
  }) as never;

describe("allowOutsideWorkspaceOf", () => {
  it("is true only when File edits is IDGAF", () => {
    expect(allowOutsideWorkspaceOf(stateWith("idgaf"))).toBe(true);
    for (const level of ["manual", "cautious", "automatic", "permissive"]) {
      expect(allowOutsideWorkspaceOf(stateWith(level, "idgaf")), level).toBe(
        false,
      );
    }
    expect(allowOutsideWorkspaceOf(undefined)).toBe(false);
  });
});

describe("outsideEditNote", () => {
  const ide = { getWorkspaceDirs: async () => ["file:///w/proj"] } as never;

  it("names a file outside the workspace, and only then", async () => {
    const note = await outsideEditNote(ide, "file:///w/other/x.md", true);
    expect(note?.content).toContain("Wrote outside the workspace: ");
    expect(note?.hidden).toBe(false);
    expect(await outsideEditNote(ide, "file:///w/proj/x.md", true)).toBe(
      undefined,
    );
    expect(await outsideEditNote(ide, "file:///w/other/x.md", false)).toBe(
      undefined,
    );
  });
});
