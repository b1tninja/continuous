import { describe, expect, it } from "vitest";

import {
  EditNotAppliedError,
  EditNotAppliedReason,
  editNotAppliedMessage,
} from "./editNotApplied";

describe("EditNotAppliedError", () => {
  it("carries the reason and its message", () => {
    const e = new EditNotAppliedError(EditNotAppliedReason.FileChanged);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("EditNotAppliedError");
    expect(e.reason).toBe(EditNotAppliedReason.FileChanged);
    expect(e.message).toBe(
      editNotAppliedMessage(EditNotAppliedReason.FileChanged),
    );
  });

  it("has a message for every reason that says nothing was written", () => {
    for (const reason of Object.values(EditNotAppliedReason)) {
      const message = editNotAppliedMessage(reason);
      expect(message.length).toBeGreaterThan(20);
      expect(message).toContain("nothing was written");
    }
  });

  it("tells the model to read the file again when it changed", () => {
    expect(editNotAppliedMessage(EditNotAppliedReason.FileChanged)).toMatch(
      /read the file again/i,
    );
  });
});
