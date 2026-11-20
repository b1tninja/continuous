import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it } from "vitest";
import { enteredIdgaf } from "./policySettings";

const levels = (over: Record<string, string> = {}) =>
  ({ ...DEFAULT_POLICY_LEVELS, ...over }) as typeof DEFAULT_POLICY_LEVELS;

describe("enteredIdgaf", () => {
  it("is true when an area goes to IDGAF and none was", () => {
    expect(enteredIdgaf(levels(), levels({ tools: "idgaf" }))).toBe(true);
  });

  it("is true when every area goes to IDGAF at once (the preset)", () => {
    const all = Object.fromEntries(
      Object.keys(DEFAULT_POLICY_LEVELS).map((a) => [a, "idgaf"]),
    );
    expect(enteredIdgaf(levels(), levels(all))).toBe(true);
  });

  it("is false when an area was already at IDGAF", () => {
    expect(
      enteredIdgaf(
        levels({ tools: "idgaf" }),
        levels({ tools: "idgaf", edits: "idgaf" }),
      ),
    ).toBe(false);
  });

  it("is false when nothing is at IDGAF", () => {
    expect(enteredIdgaf(levels(), levels({ tools: "permissive" }))).toBe(false);
  });

  it("is false when leaving IDGAF", () => {
    expect(enteredIdgaf(levels({ tools: "idgaf" }), levels())).toBe(false);
  });

  it("reads the old name yolo as IDGAF", () => {
    expect(enteredIdgaf(levels(), levels({ tools: "yolo" }))).toBe(true);
  });
});
