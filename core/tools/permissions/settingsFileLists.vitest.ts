import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  policyUpdateProblem,
  writePolicyFile,
} from "./settingsFile";

const FILE = `# my settings
levels:
  tools: cautious # keep me
floor:
  - runTerminalCommand(git push --force*) # never, ever
  - runTerminalCommand(terraform destroy*)
plan:
  maxNewItems: 3
  mcpTools:
    - github/get_issue
mcpServers:
  docs: trusted
allow:
  - Bash(npm test)
`;

describe("permissions.yaml lists written by the Custom policy page", () => {
  it("writing the lists as they are changes nothing", () => {
    const read = parsePolicyFile(FILE).settings;
    expect(
      applyPolicyUpdate(FILE, {
        floor: read.floor,
        planMcpTools: read.planMcpTools,
        trustedMcpServers: Object.keys(read.mcpServers ?? {}),
      }),
    ).toBe(FILE);
  });

  it("floor: kept rules keep their comments, removed go, new ones go at the end", () => {
    const next = applyPolicyUpdate(FILE, {
      floor: [
        "runTerminalCommand(git push --force*)",
        "runTerminalCommand(rm -rf /*)",
      ],
    });
    expect(next).toBe(`# my settings
levels:
  tools: cautious # keep me
floor:
  - runTerminalCommand(git push --force*) # never, ever
  - runTerminalCommand(rm -rf /*)
plan:
  maxNewItems: 3
  mcpTools:
    - github/get_issue
mcpServers:
  docs: trusted
allow:
  - Bash(npm test)
`);
    expect(parsePolicyFile(next).settings.floor).toEqual([
      "runTerminalCommand(git push --force*)",
      "runTerminalCommand(rm -rf /*)",
    ]);
    // An empty list removes the key; the CLI's own lists are not touched
    const none = applyPolicyUpdate(FILE, { floor: [] });
    expect(none).not.toContain("floor");
    expect(none).toContain("- Bash(npm test)");
  });

  it("trusted servers and Plan's MCP tools", () => {
    const next = applyPolicyUpdate(FILE, {
      trustedMcpServers: ["search"],
      planMcpTools: ["github/get_issue", "docs/*"],
      planAllowTerminal: true,
    });
    const read = parsePolicyFile(next).settings;
    expect(read.mcpServers).toEqual({ search: "trusted" });
    expect(read.planMcpTools).toEqual(["github/get_issue", "docs/*"]);
    expect(read.planAllowTerminal).toBe(true);
    expect(read.maxNewPlanItems).toBe(3);
    // Back again
    const back = applyPolicyUpdate(next, {
      trustedMcpServers: ["docs"],
      planMcpTools: ["github/get_issue"],
      planAllowTerminal: false,
    });
    expect(parsePolicyFile(back).settings).toMatchObject({
      mcpServers: { docs: "trusted" },
      planMcpTools: ["github/get_issue"],
    });
    expect(parsePolicyFile(back).settings.planAllowTerminal).toBeUndefined();
  });

  it("refuses what cannot be read back, and writes nothing", () => {
    expect(policyUpdateProblem({ floor: ["runTerminalCommand()"] })).toContain(
      "A pattern in brackets cannot be empty",
    );
    expect(policyUpdateProblem({ planMcpTools: ["a/b/c"] })).toBe(
      'plan.mcpTools: "a/b/c": write server/tool, server/* or server.',
    );
    expect(policyUpdateProblem({ trustedMcpServers: [" "] })).toBe(
      'mcpServers: " " is not a server name.',
    );
    expect(policyUpdateProblem({ floor: ["readFile(.env)"] })).toBeUndefined();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-lists-"));
    const file = path.join(dir, "permissions.yaml");
    try {
      fs.writeFileSync(file, FILE);
      expect(() =>
        writePolicyFile(file, { floor: ["runTerminalCommand()"] }),
      ).toThrow(/^Not saved: floor/);
      expect(fs.readFileSync(file, "utf8")).toBe(FILE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
