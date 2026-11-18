import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it } from "vitest";

import {
  decideAgentSessionTool,
  vscodeToolToCoreCall,
} from "./agentSessionPolicy";

describe("Agents window tool policy", () => {
  const cautious = { levels: DEFAULT_POLICY_LEVELS };

  it("maps terminal and file tools onto core calls", () => {
    expect(
      vscodeToolToCoreCall("runInTerminal", { command: "git push" }),
    ).toEqual({
      toolName: "run_terminal_command",
      parsedArgs: { command: "git push" },
    });
    expect(vscodeToolToCoreCall("readFile", { path: ".env" }).toolName).toBe(
      "read_file",
    );
    expect(
      vscodeToolToCoreCall("editFile", { filePath: "src/a.ts" }).toolName,
    ).toBe("edit_existing_file");
  });

  it("refuses a floor rule and asks for a protected path", () => {
    const floor = decideAgentSessionTool(
      "runInTerminal",
      { command: "git push" },
      {
        approval: {
          levels: { ...DEFAULT_POLICY_LEVELS, tools: "permissive" },
          floor: ["runTerminalCommand(git push*)"],
        },
      },
    );
    expect(floor.policy).toBe("disabled");
    expect(floor.source).toBe("floor");

    // IDGAF runs it, and the decision records the floor rule
    const idgaf = decideAgentSessionTool(
      "runInTerminal",
      { command: "git push" },
      {
        approval: {
          levels: { ...DEFAULT_POLICY_LEVELS, tools: "idgaf" },
          floor: ["runTerminalCommand(git push*)"],
        },
      },
    );
    expect(idgaf.policy).toBe("allowedWithoutPermission");
    expect(idgaf.source).toBe("idgaf");
    expect(idgaf.reason).toContain("would have been refused");

    const secret = decideAgentSessionTool(
      "readFile",
      { path: ".env" },
      {
        approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools: "permissive" } },
      },
    );
    expect(secret.policy).toBe("allowedWithPermission");
    expect(secret.source).toBe("protected-path");
  });

  it("asks at the default levels and honors a deny rule", () => {
    expect(
      decideAgentSessionTool(
        "runInTerminal",
        { command: "npm test" },
        { approval: cautious },
      ).policy,
    ).toBe("allowedWithPermission");
    expect(
      decideAgentSessionTool(
        "runInTerminal",
        { command: "npm test" },
        {
          approval: cautious,
          permissions: { deny: ["runTerminalCommand(npm test*)"] },
        },
      ).policy,
    ).toBe("disabled");
  });
});
