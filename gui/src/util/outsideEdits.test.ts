import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import { allowOutsideWorkspaceOf, outsideEditNote } from "./outsideEdits";

const stateWith = (
  edits: string,
  tools = "cautious",
  builtin?: Record<string, boolean>,
) =>
  ({
    ui: {
      policyLevels: {
        context: "cautious",
        tools,
        edits,
        plan: "cautious",
        questions: "cautious",
      },
      policyExtras: builtin ? { builtin } : {},
    },
    config: { config: { experimental: {}, selectedModelByRole: {} } },
  }) as never;

describe("allowOutsideWorkspaceOf", () => {
  it("is true only when the outside-paths check is off, whatever the levels", () => {
    // The IDGAF preset leaves no check on
    expect(
      allowOutsideWorkspaceOf(
        stateWith("idgaf", "idgaf", builtinForPreset("idgaf")),
      ),
    ).toBe(true);
    for (const level of ["manual", "cautious", "automatic", "permissive"]) {
      expect(
        allowOutsideWorkspaceOf(
          stateWith(level, "cautious", { "ask-outside-paths": false }),
        ),
        level,
      ).toBe(true);
    }
  });

  it("is false while the check is on, even with File edits at IDGAF", () => {
    expect(allowOutsideWorkspaceOf(stateWith("idgaf"))).toBe(false);
    expect(allowOutsideWorkspaceOf(stateWith("idgaf", "idgaf", {}))).toBe(
      false,
    );
    expect(
      allowOutsideWorkspaceOf(
        stateWith("permissive", "cautious", { "ask-large-change": false }),
      ),
    ).toBe(false);
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
