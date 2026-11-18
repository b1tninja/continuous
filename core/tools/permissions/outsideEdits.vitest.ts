import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createNewFileTool, editFileTool } from "../definitions";
import { evaluateToolPolicyWithRules, type EvaluateInput } from "./evaluate";
import { editsAllowOutsideWorkspace, wroteOutsideNote } from "./outsideEdits";
import type { PolicyLevel } from "./policy";

const ASK = "allowedWithPermission";
const ALLOW = "allowedWithoutPermission";
const OFF = "disabled";

const CWD = "/home/me/proj";
const OUTSIDE = "/srv/other/docs/x.md";

function write(
  tool: typeof createNewFileTool | typeof editFileTool,
  filepath: string,
  opts: {
    edits: PolicyLevel;
    tools?: PolicyLevel;
    within?: boolean;
    permissions?: EvaluateInput["permissions"];
    floor?: string[];
    builtin?: Record<string, boolean>;
  },
) {
  const within = opts.within ?? false;
  return evaluateToolPolicyWithRules({
    tool,
    toolName: tool.function.name,
    basePolicy: tool.defaultToolPolicy,
    parsedArgs: { filepath },
    processedArgs: {
      resolvedPath: {
        uri: pathToFileURL(filepath).href,
        displayPath: filepath,
        isAbsolute: true,
        isWithinWorkspace: within,
      },
    },
    permissions: opts.permissions,
    cwd: CWD,
    workspaceDirs: [CWD],
    shell: "bash",
    platform: "posix",
    home: "/home/me",
    approval: {
      levels: {
        context: "cautious",
        tools: opts.tools ?? "cautious",
        edits: opts.edits,
        plan: "cautious",
        questions: "cautious",
      },
      ...(opts.floor ? { floor: opts.floor } : {}),
      ...(opts.builtin ? { builtin: opts.builtin } : {}),
    },
  } as EvaluateInput);
}

const TOOLS = [createNewFileTool, editFileTool] as const;

describe("File edits outside the workspace, by level", () => {
  it("IDGAF carries it out, with no prompt, and says where it lands", () => {
    for (const tool of TOOLS) {
      const r = write(tool, OUTSIDE, { edits: "idgaf" });
      expect(r.policy, tool.function.name).toBe(ALLOW);
      expect(r.source).toBe("idgaf");
      expect(r.reason).toContain("File edits is set to IDGAF");
      expect(r.reason).toContain("The target is outside the workspace: ");
      // a POSIX path on a Windows host gains a drive letter
      expect(r.reason).toContain(OUTSIDE);
    }
  });

  it("does not say it for a target inside the workspace", () => {
    const r = write(createNewFileTool, `${CWD}/src/new.ts`, {
      edits: "idgaf",
      within: true,
    });
    expect(r.policy).toBe(ALLOW);
    expect(r.reason).not.toContain("outside the workspace");
  });

  it("IDGAF ignores Never rules, Ask rules, protected paths and the switch for the check", () => {
    expect(
      write(createNewFileTool, OUTSIDE, {
        edits: "idgaf",
        permissions: { deny: ["writeFile(**)"] },
      }).policy,
    ).toBe(ALLOW);
    expect(
      write(createNewFileTool, OUTSIDE, {
        edits: "idgaf",
        permissions: { ask: ["writeFile(**)"] },
      }).policy,
    ).toBe(ALLOW);
    expect(
      write(createNewFileTool, "/srv/other/.env", { edits: "idgaf" }).policy,
    ).toBe(ALLOW);
    expect(
      write(createNewFileTool, OUTSIDE, {
        edits: "idgaf",
        builtin: { "ask-outside-paths": false },
      }).policy,
    ).toBe(ALLOW);
  });

  it("the tainted-session rule is off by default, so it does not hold a IDGAF write", () => {
    // No taint fact reaches the evaluator unless the person turned the rule on.
    expect(write(editFileTool, OUTSIDE, { edits: "idgaf" }).policy).toBe(ALLOW);
  });

  it("IDGAF runs what the floor or the policy-file lock would refuse, and records it", () => {
    const floored = write(createNewFileTool, OUTSIDE, {
      edits: "idgaf",
      floor: ["writeFile(/srv/other/**)"],
    });
    expect(floored.policy).toBe(ALLOW);
    expect(floored.idgafOverride).toMatchObject({
      policy: OFF,
      source: "floor",
    });
    const own = write(createNewFileTool, "/home/me/.continue/config.yaml", {
      edits: "idgaf",
    });
    expect(own.policy).toBe(ALLOW);
    expect(own.idgafOverride).toMatchObject({ policy: OFF, source: "floor" });
  });

  it("Manual, Cautious and Automatic still ask, with the note", () => {
    for (const edits of ["manual", "cautious", "automatic"] as const) {
      for (const tool of TOOLS) {
        const r = write(tool, OUTSIDE, { edits });
        expect(r.policy, `${edits} ${tool.function.name}`).toBe(ASK);
        expect(r.reason).toContain("outside the workspace");
      }
    }
  });

  it("Permissive holds it too: no rule stops it, but the outside-paths protection does", () => {
    const r = write(createNewFileTool, OUTSIDE, { edits: "permissive" });
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("protected-path");
  });

  it("another area at IDGAF does not free a file edit", () => {
    const r = write(createNewFileTool, OUTSIDE, {
      edits: "cautious",
      tools: "idgaf",
    });
    expect(r.policy).toBe(ASK);
  });

  it("a deny rule still refuses at Cautious and Permissive", () => {
    for (const edits of ["cautious", "permissive"] as const) {
      expect(
        write(createNewFileTool, OUTSIDE, {
          edits,
          permissions: { deny: ["writeFile(**)"] },
        }).policy,
      ).toBe(OFF);
    }
  });
});

describe("outsideEdits helpers", () => {
  it("only the File edits level decides", () => {
    const levels = (edits: PolicyLevel, tools: PolicyLevel = "cautious") =>
      ({
        levels: {
          context: "cautious",
          tools,
          edits,
          plan: "cautious",
          questions: "cautious",
        },
      }) as never;
    expect(editsAllowOutsideWorkspace(levels("idgaf"))).toBe(true);
    for (const l of [
      "manual",
      "cautious",
      "automatic",
      "permissive",
    ] as const) {
      expect(editsAllowOutsideWorkspace(levels(l, "idgaf"))).toBe(false);
    }
    expect(editsAllowOutsideWorkspace(undefined)).toBe(false);
  });

  it("names the path in the transcript note", () => {
    expect(wroteOutsideNote("/srv/a/b.md")).toBe(
      "Wrote outside the workspace: /srv/a/b.md",
    );
    expect(wroteOutsideNote(pathToFileURL("/srv/a/b.md").href)).toContain(
      "Wrote outside the workspace: ",
    );
  });
});
