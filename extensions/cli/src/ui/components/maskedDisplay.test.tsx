import { render } from "ink-testing-library";
import React from "react";

import { runTerminalCommandTool } from "../../tools/runTerminalCommand.js";
import { ToolCallTitle } from "../../tools/ToolCallTitle.js";

import { ToolPermissionRequest } from "./ToolPermissionRequest.js";
import { ToolPermissionSelector } from "./ToolPermissionSelector.js";
import { ToolPreview } from "./ToolPreview.js";

// Fake values only: shaped like secrets, belonging to nobody
const FAKE = "fake-token-value-for-tests";
const COMMAND = `API_KEY=${FAKE} npm test`;
const PS_COMMAND = `$env:GITHUB_TOKEN='${FAKE}'; git push`;

function frameOf(node: React.ReactElement): string {
  const { lastFrame, unmount } = render(node);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

describe("what an approval prompt shows of a command", () => {
  it("the title names the variable and hides the value", () => {
    const out = frameOf(
      <ToolCallTitle toolName="Bash" args={{ command: COMMAND }} />,
    );
    expect(out).toContain("API_KEY=");
    expect(out).not.toContain(FAKE);
  });

  it("the PowerShell form is hidden too", () => {
    const out = frameOf(
      <ToolCallTitle toolName="Bash" args={{ command: PS_COMMAND }} />,
    );
    expect(out).toContain("GITHUB_TOKEN");
    expect(out).not.toContain(FAKE);
  });

  it("the preview line is masked", () => {
    const out = frameOf(
      <ToolPreview
        toolName="Bash"
        toolArgs={{ command: COMMAND }}
        toolCallPreview={[{ type: "text", content: `Will run: ${COMMAND}` }]}
      />,
    );
    expect(out).toContain("API_KEY=");
    expect(out).not.toContain(FAKE);
  });

  it("the y/n request is masked", () => {
    const out = frameOf(
      <ToolPermissionRequest
        toolName="Bash"
        toolArgs={{ command: COMMAND }}
        requestId="r1"
        onResponse={() => {}}
      />,
    );
    expect(out).toContain("API_KEY");
    expect(out).not.toContain(FAKE);
  });

  it("the selector shows no value in the title, preview or the always-allow line", () => {
    const out = frameOf(
      <ToolPermissionSelector
        toolName="Bash"
        toolArgs={{ command: COMMAND }}
        requestId="r1"
        toolCallPreview={[{ type: "text", content: `Will run: ${COMMAND}` }]}
        onResponse={() => {}}
      />,
    );
    expect(out).toContain("API_KEY");
    expect(out).not.toContain(FAKE);
  });

  it("the arguments the tool is called with are not changed by any of it", async () => {
    const args = { command: COMMAND };
    frameOf(<ToolCallTitle toolName="Bash" args={args} />);
    expect(args.command).toBe(COMMAND);
    // the tool's own preprocess hands back the real command to run
    const pre = await runTerminalCommandTool.preprocess!(args);
    expect(pre.args.command).toBe(COMMAND);
  });
});
