import { render } from "ink-testing-library";
import React from "react";

import { ToolArgsDetail } from "./ToolArgsDetail.js";
import { ToolPermissionSelector } from "./ToolPermissionSelector.js";

const FAKE = "fake-token-value-for-tests";

function frameOf(node: React.ReactElement): string {
  const { lastFrame, unmount } = render(node);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

describe("ToolArgsDetail", () => {
  it("lists a long command in full, past the preview's 60 characters", () => {
    const tail = "THE-END-OF-THE-COMMAND";
    const command = `echo ${"x".repeat(120)} ${tail}`;
    const out = frameOf(<ToolArgsDetail toolArgs={{ command }} />);
    expect(out).toContain("command:");
    expect(out.replace(/\s+/g, "")).toContain(tail);
  });

  it("hides a secret value but keeps the variable name", () => {
    const out = frameOf(
      <ToolArgsDetail toolArgs={{ command: `API_KEY=${FAKE} npm test` }} />,
    );
    expect(out).toContain("API_KEY=");
    expect(out).not.toContain(FAKE);
  });

  it("says how long a very long value is instead of printing it", () => {
    const out = frameOf(
      <ToolArgsDetail toolArgs={{ contents: "y".repeat(5000) }} />,
    );
    expect(out).toContain("5000 characters");
  });

  it("shows nothing for a call with no arguments", () => {
    expect(frameOf(<ToolArgsDetail toolArgs={{}} />)).toBe("");
  });

  it("is part of the approval prompt", () => {
    const out = frameOf(
      <ToolPermissionSelector
        toolName="Fetch"
        toolArgs={{ url: "https://example.com/a/very/specific/path" }}
        requestId="r1"
        onResponse={() => {}}
      />,
    );
    expect(out).toContain("https://example.com/a/very/specific/path");
  });
});
