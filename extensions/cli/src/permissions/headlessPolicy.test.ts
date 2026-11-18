import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  model: { assistant: undefined as any, authConfig: {} as any },
}));

vi.mock("../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => state.model),
    getSync: vi.fn(() => ({ value: state.model })),
  },
  services: { chatHistory: { getHistory: () => [] } },
}));

vi.mock("core/tools/permissions/audit/global.js", () => ({
  getAuditTrail: () => ({
    enabled: false,
    decision: vi.fn(),
    answer: vi.fn(),
    outcome: vi.fn(),
  }),
}));

import {
  announceHeadlessPolicy,
  processCommandFlags,
} from "../flags/flagProcessor.js";
import { ToolPermissionService } from "../services/ToolPermissionService.js";
import { checkToolPermissionApproval } from "../stream/streamChatResponse.helpers.js";

import { getDefaultToolPolicies } from "./defaultPolicies.js";
import {
  HEADLESS_LEGACY_ENV,
  headlessAskRefusal,
  headlessLegacyAllow,
  headlessPolicyNotice,
  isPolicyFileSpec,
  noteHeadlessRefusal,
  resetHeadlessRefusalNotes,
  resolvePolicyFile,
} from "./headlessPolicy.js";
import {
  effectiveLevels,
  getPolicyLevels,
  parsePolicySpec,
  resetPolicyLevels,
  setPolicyLevels,
} from "./policyLevels.js";

const bash = (command: string): any => ({
  id: "call-1",
  name: "Bash",
  arguments: { command },
  argumentsStr: JSON.stringify({ command }),
  tool: {
    evaluateToolCallPolicy: (base: any, args: any) =>
      evaluateTerminalCommandSecurity(base, args.command),
  },
});

const write = (): any => ({
  id: "call-2",
  name: "Write",
  arguments: { filepath: "notes.txt", content: "x" },
  argumentsStr: "{}",
  tool: {},
});

const mcpTool = (): any => ({
  id: "call-3",
  name: "mcp__wiki__search",
  arguments: { q: "x" },
  argumentsStr: "{}",
  tool: { mcpServer: "wiki", mcpToolName: "search" },
});

/** The lists a headless run takes now: the interactive ones. */
const headlessLists = () => ({
  policies: getDefaultToolPolicies(true, false),
});

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPolicyLevels();
  resetHeadlessRefusalNotes();
  delete process.env[HEADLESS_LEGACY_ENV];
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  delete process.env[HEADLESS_LEGACY_ENV];
  resetPolicyLevels();
});

function atLevels(spec: string) {
  const parsed = parsePolicySpec(spec);
  if (!parsed.ok) throw new Error(parsed.error);
  setPolicyLevels(parsed.levels);
}

describe("headless default lists (CO2)", () => {
  it("are the interactive lists: Bash and unlisted tools ask", () => {
    expect(getDefaultToolPolicies(true, false)).toEqual(
      getDefaultToolPolicies(false, false),
    );
    const lists = getDefaultToolPolicies(true, false);
    expect(lists).toContainEqual({ tool: "Bash", permission: "ask" });
    expect(lists).toContainEqual({ tool: "*", permission: "ask" });
    expect(lists).not.toContainEqual({ tool: "Bash", permission: "allow" });
  });

  it("the escape hatch brings back the old headless allows", () => {
    const lists = getDefaultToolPolicies(true, true);
    expect(lists).toContainEqual({ tool: "Bash", permission: "allow" });
    expect(lists).toContainEqual({ tool: "*", permission: "allow" });
    // and never changes the terminal UI's lists
    expect(getDefaultToolPolicies(false, true)).toEqual(
      getDefaultToolPolicies(false, false),
    );
  });

  it("reads the hatch from the environment", () => {
    expect(headlessLegacyAllow({})).toBe(false);
    expect(headlessLegacyAllow({ [HEADLESS_LEGACY_ENV]: "1" })).toBe(true);
    expect(headlessLegacyAllow({ [HEADLESS_LEGACY_ENV]: "true" })).toBe(true);
    expect(headlessLegacyAllow({ [HEADLESS_LEGACY_ENV]: "0" })).toBe(false);
    process.env[HEADLESS_LEGACY_ENV] = "1";
    expect(getDefaultToolPolicies(true)).toContainEqual({
      tool: "Bash",
      permission: "allow",
    });
  });
});

describe("each level, headless", () => {
  it("defaults (Careful): a command that would ask is refused, saying how to allow it", async () => {
    const r = await checkToolPermissionApproval(
      headlessLists(),
      bash("npm test"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
    expect(r.denialReason).toBe("policy");
    expect(r.denialMessage).toMatch(/headless/);
    expect(r.denialMessage).toContain("--auto");
    expect(r.denialMessage).toContain("--policy");
  });

  it("defaults (Careful): an edit is refused, an MCP tool is refused", async () => {
    for (const call of [write(), mcpTool()]) {
      const r = await checkToolPermissionApproval(
        headlessLists(),
        call,
        {},
        true,
      );
      expect(r.approved, call.name).toBe(false);
      expect(r.denialMessage, call.name).toContain("--policy");
    }
  });

  it("defaults (Careful): a read-only command still runs (Context use is Permissive)", async () => {
    const r = await checkToolPermissionApproval(
      headlessLists(),
      bash("ls"),
      {},
      true,
    );
    expect(r).toEqual({ approved: true });
  });

  it("Manual on Tool use: the command is refused", async () => {
    atLevels("tools=manual");
    const r = await checkToolPermissionApproval(
      headlessLists(),
      bash("npm test"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
  });

  it("Permissive (handsOff): the command runs; edits run", async () => {
    atLevels("handsOff");
    expect(
      await checkToolPermissionApproval(
        headlessLists(),
        bash("npm test"),
        {},
        true,
      ),
    ).toEqual({ approved: true });
    expect(
      await checkToolPermissionApproval(headlessLists(), write(), {}, true),
    ).toEqual({ approved: true });
  });

  it("Permissive (handsOff): a call that always asks below IDGAF is still refused", async () => {
    atLevels("handsOff");
    const r = await checkToolPermissionApproval(
      headlessLists(),
      bash("npm install left-pad"),
      {},
      true,
    );
    expect(r.approved).toBe(false);
    expect(r.denialMessage).toMatch(/always asks first/);
    expect(r.denialMessage).toMatch(/headless/);
  });

  it("IDGAF: everything runs, nothing is refused or asked", async () => {
    atLevels("idgaf");
    for (const call of [bash("npm install left-pad"), write(), mcpTool()]) {
      expect(
        await checkToolPermissionApproval(headlessLists(), call, {}, true),
        call.name,
      ).toEqual({ approved: true });
    }
    expect(stderr).not.toHaveBeenCalled();
  });

  it("--auto: IDGAF on the tool areas, so the command runs headless", async () => {
    const levels = effectiveLevels("auto");
    expect(levels.tools).toBe("idgaf");
    setPolicyLevels(levels);
    expect(
      await checkToolPermissionApproval(
        headlessLists(),
        bash("npm install left-pad"),
        {},
        true,
      ),
    ).toEqual({ approved: true });
  });

  it("the terminal UI still asks the person for the same call", async () => {
    const shown: string[] = [];
    const { toolPermissionManager } = await import("./permissionManager.js");
    const pending = checkToolPermissionApproval(
      headlessLists(),
      bash("npm install left-pad"),
      {
        onToolPermissionRequest: vi.fn((_n: string, _a: any, id: string) =>
          shown.push(id),
        ),
      },
      false,
    );
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    toolPermissionManager.rejectRequest(shown[0]);
    expect((await pending).denialReason).toBe("user");
  });
});

describe("ask -> refuse, text and stderr", () => {
  it("the tool result names the tool, the reason and the way out", () => {
    const text = headlessAskRefusal("Bash");
    expect(text).toContain("Bash needs approval at your levels.");
    expect(text).toContain("Running headless, so it was refused");
    expect(text).toContain("--policy handsOff");
    expect(text).toContain("--allow <tool>");
    expect(headlessAskRefusal("Bash", "A rule asks.")).toMatch(
      /^A rule asks\. Running headless/,
    );
  });

  it("one stderr line per tool name", async () => {
    await checkToolPermissionApproval(
      headlessLists(),
      bash("npm install a"),
      {},
      true,
    );
    await checkToolPermissionApproval(
      headlessLists(),
      bash("npm install b"),
      {},
      true,
    );
    await checkToolPermissionApproval(headlessLists(), write(), {}, true);
    const lines = stderr.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      lines.filter((l: string) => l.includes("refused Bash")),
    ).toHaveLength(1);
    expect(
      lines.filter((l: string) => l.includes("refused Write")),
    ).toHaveLength(1);
    expect(lines[0]).toContain("--policy");
  });

  it("noteHeadlessRefusal writes through the sink it is given", () => {
    const out: string[] = [];
    noteHeadlessRefusal("Edit", (l) => out.push(l));
    noteHeadlessRefusal("Edit", (l) => out.push(l));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^continuous: refused Edit/);
  });
});

describe("--policy <level|file>", () => {
  it("a preset or levels opt in", () => {
    processCommandFlags({ policy: "handsOff" });
    expect(getPolicyLevels().tools).toBe("permissive");
    processCommandFlags({ policy: "tools=automatic" });
    expect(getPolicyLevels().tools).toBe("automatic");
  });

  it("tells a file from a spec", () => {
    expect(isPolicyFileSpec("./ci-policy.yaml")).toBe(true);
    expect(isPolicyFileSpec("../p.yml")).toBe(true);
    expect(isPolicyFileSpec("/etc/cn/policy")).toBe(true);
    expect(isPolicyFileSpec("~/ci.yaml")).toBe(true);
    expect(isPolicyFileSpec("C:\\ci\\policy.yaml")).toBe(true);
    expect(isPolicyFileSpec("ci.yaml")).toBe(true);
    expect(isPolicyFileSpec("handsOff")).toBe(false);
    expect(isPolicyFileSpec("tools=permissive,plan=manual")).toBe(false);
    expect(resolvePolicyFile("~/x.yaml")).toBe(
      path.join(os.homedir(), "x.yaml"),
    );
  });

  it("a file in the permissions.yaml format sets the levels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-policy-"));
    try {
      const file = path.join(dir, "ci-policy.yaml");
      fs.writeFileSync(
        file,
        "levels:\n  tools: permissive\n  edits: permissive\n",
      );
      processCommandFlags({ policy: file });
      expect(getPolicyLevels().tools).toBe("permissive");
      expect(getPolicyLevels().edits).toBe("permissive");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing file is an error, not the defaults", () => {
    expect(() =>
      processCommandFlags({ policy: "./no-such-policy-file.yaml" }),
    ).toThrow(/--policy: no policy file at/);
  });

  it("a file cannot set IDGAF (one session only, as in permissions.yaml)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-policy-"));
    try {
      const file = path.join(dir, "p.yaml");
      fs.writeFileSync(file, "levels:\n  tools: idgaf\n");
      processCommandFlags({ policy: file });
      expect(getPolicyLevels().tools).not.toBe("idgaf");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the start-up line", () => {
  it("names the levels and says an ask is refused", () => {
    const out: string[] = [];
    announceHeadlessPolicy({}, (l) => out.push(l));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^continuous: headless run at your levels/);
    expect(out[0]).toContain("Tool use Cautious");
    expect(out[0]).toContain("refused");
    expect(out[0]).toContain("--auto or --policy");
  });

  it("names the flag that opted in", () => {
    const out: string[] = [];
    announceHeadlessPolicy({ auto: true }, (l) => out.push(l));
    announceHeadlessPolicy({ policy: "handsOff" }, (l) => out.push(l));
    expect(out[0]).toContain("at --auto");
    expect(out[0]).toContain("IDGAF");
    expect(out[1]).toContain("at --policy handsOff");
  });

  it("the hatch says it is on and that it goes away", () => {
    process.env[HEADLESS_LEGACY_ENV] = "1";
    const out: string[] = [];
    announceHeadlessPolicy({}, (l) => out.push(l));
    expect(out[0]).toContain(`${HEADLESS_LEGACY_ENV}=1`);
    expect(out[0]).toContain("removed in the next release");
    expect(headlessPolicyNotice({ levels: getPolicyLevels() })).not.toContain(
      HEADLESS_LEGACY_ENV,
    );
  });
});

describe("serve and -p take the same lists (the tool service, headless)", () => {
  it("Bash and unlisted tools ask in a headless service", () => {
    const service = new ToolPermissionService();
    const s = service.initializeSync({ isHeadless: true });
    const bashPolicy = s.permissions.policies.find((p) => p.tool === "Bash");
    expect(bashPolicy?.permission).toBe("ask");
    expect(s.permissions.policies.find((p) => p.tool === "*")?.permission).toBe(
      "ask",
    );
  });

  it("with the hatch, the headless service allows them as before", () => {
    process.env[HEADLESS_LEGACY_ENV] = "1";
    const service = new ToolPermissionService();
    const s = service.initializeSync({ isHeadless: true });
    expect(s.permissions.policies.find((p) => p.tool === "Bash")).toEqual({
      tool: "Bash",
      permission: "allow",
    });
  });

  it("a loop worker of a terminal parent keeps the interactive lists under the hatch", () => {
    process.env[HEADLESS_LEGACY_ENV] = "1";
    const service = new ToolPermissionService();
    const s = service.initializeSync({
      isHeadless: true,
      interactiveDefaults: true,
    });
    expect(
      s.permissions.policies.find((p) => p.tool === "Bash")?.permission,
    ).toBe("ask");
  });
});
