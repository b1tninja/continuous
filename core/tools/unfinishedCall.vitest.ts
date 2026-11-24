import { describe, expect, it } from "vitest";
import { NO_TOOL_CALL_OUTPUT_MESSAGE } from "./constants";
import { unfinishedToolCallOutput } from "./unfinishedCall";

describe("what a tool call with no output is said to be", () => {
  it("a call cut off while it was written did not run", () => {
    const text = unfinishedToolCallOutput("generating");
    expect(text).toContain("did not run");
    expect(text).toContain("Nothing was changed");
    expect(text).not.toContain("No tool output");
  });

  it("a call waiting for approval has not run", () => {
    expect(unfinishedToolCallOutput("generated")).toContain("has not run");
  });

  it("a call still running has an unknown result, so check before relying on it", () => {
    expect(unfinishedToolCallOutput("calling")).toContain("not known");
  });

  it("a finished call that printed nothing is still 'No tool output'", () => {
    expect(unfinishedToolCallOutput("done")).toBe(NO_TOOL_CALL_OUTPUT_MESSAGE);
    expect(unfinishedToolCallOutput(undefined)).toBe(
      NO_TOOL_CALL_OUTPUT_MESSAGE,
    );
  });
});
