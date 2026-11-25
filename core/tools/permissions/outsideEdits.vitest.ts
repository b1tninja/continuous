import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createNewFileTool, editFileTool } from "../definitions";
import { evaluateToolPolicyWithRules, type EvaluateInput } from "./evaluate";
import { editsAllowOutsideWorkspace, wroteOutsideNote } from "./outsideEdits";
import type { PolicyLevel } from "./policy";
import { builtinForDegree, builtinForPreset } from "./safetyDegrees";

// The IDGAF preset leaves no safety check on. These tests use it for "IDGAF";
// IDGAF levels alone (checks left on) have their own cases below.
const NO_CHECKS = builtinForPreset("idgaf");

const ASK = "allowedWithPermission";
const ALLOW = "allowedWithoutPermission";
const OFF = "disabled";

const CWD = "/home/me/proj";
const OUTSIDE = "/srv/other/docs/x.md";

function write(
  tool: typeof createNewFileTool | typeof editFileTool,
  filepath: string,
  opts: {
    // "idgaf" is this file's word for Permissive (the preset's switches, when
    // the test passes them): the retired level is not a PolicyLevel any more
    edits: PolicyLevel | "idgaf";
    tools?: PolicyLevel | "idgaf";
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
        tools:
          opts.tools === "idgaf" ? "permissive" : (opts.tools ?? "cautious"),
        edits: opts.edits === "idgaf" ? "permissive" : opts.edits,
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
  it("the IDGAF preset carries it out, with no prompt, and says where it lands", () => {
    for (const tool of TOOLS) {
      const r = write(tool, OUTSIDE, { edits: "idgaf", builtin: NO_CHECKS });
      expect(r.policy, tool.function.name).toBe(ALLOW);
      expect(r.source).toBe("permissive");
      expect(r.reason).toContain("File edits is Permissive");
      expect(r.reason).toContain("The target is outside the workspace: ");
      // a POSIX path on a Windows host gains a drive letter
      expect(r.reason).toContain(OUTSIDE);
    }
  });

  it("with the outside-paths check on, IDGAF levels still ask: the check decides, not the level", () => {
    for (const tool of TOOLS) {
      const r = write(tool, OUTSIDE, { edits: "idgaf" });
      expect(r.policy, tool.function.name).toBe(ASK);
      expect(r.protection).toBe("file-deputy");
    }
  });

  it("turning only that check off lets it through, at any level", () => {
    for (const edits of ["cautious", "permissive", "automatic"] as const) {
      expect(
        write(createNewFileTool, OUTSIDE, {
          edits,
          builtin: { "ask-outside-paths": false },
        }).policy,
        edits,
      ).not.toBe(OFF);
    }
    expect(
      write(createNewFileTool, OUTSIDE, {
        edits: "permissive",
        builtin: { "ask-outside-paths": false },
      }).policy,
    ).toBe(ALLOW);
  });

  it("does not say it for a target inside the workspace", () => {
    const r = write(createNewFileTool, `${CWD}/src/new.ts`, {
      edits: "idgaf",
      builtin: NO_CHECKS,
      within: true,
    });
    expect(r.policy).toBe(ALLOW);
    expect(r.reason).not.toContain("outside the workspace");
  });

  it("the IDGAF preset ignores Never rules, Ask rules, protected paths and every check", () => {
    const idgaf = { edits: "idgaf", builtin: NO_CHECKS } as const;
    expect(
      write(createNewFileTool, OUTSIDE, {
        ...idgaf,
        permissions: { deny: ["writeFile(**)"] },
      }).policy,
    ).toBe(ALLOW);
    expect(
      write(createNewFileTool, OUTSIDE, {
        ...idgaf,
        permissions: { ask: ["writeFile(**)"] },
      }).policy,
    ).toBe(ALLOW);
    expect(write(createNewFileTool, "/srv/other/.env", idgaf).policy).toBe(
      ALLOW,
    );
    expect(write(createNewFileTool, OUTSIDE, idgaf).policy).toBe(ALLOW);
  });

  it("the tainted-session rule is off by default, so it does not hold a IDGAF write", () => {
    // No taint fact reaches the evaluator unless the person turned the rule on.
    expect(
      write(editFileTool, OUTSIDE, { edits: "idgaf", builtin: NO_CHECKS })
        .policy,
    ).toBe(ALLOW);
  });

  it("the floor and the policy-file lock are each their own switch", () => {
    const floor = ["writeFile(/srv/other/**)"];
    // every check off: nothing stands in front of either
    const floored = write(createNewFileTool, OUTSIDE, {
      edits: "idgaf",
      builtin: NO_CHECKS,
      floor,
    });
    expect(floored.policy).toBe(ALLOW);
    expect(floored).not.toHaveProperty("idgafOverride");
    const own = write(createNewFileTool, "/home/me/.continue/config.yaml", {
      edits: "idgaf",
      builtin: NO_CHECKS,
    });
    expect(own.policy).toBe(ALLOW);
    expect(own).not.toHaveProperty("idgafOverride");
    // turn back on only the switch of each, and each stops it
    expect(
      write(createNewFileTool, OUTSIDE, {
        edits: "idgaf",
        builtin: { ...NO_CHECKS, "apply-rules": true },
        floor,
      }),
    ).toMatchObject({ policy: OFF, source: "floor" });
    expect(
      write(createNewFileTool, "/home/me/.continue/config.yaml", {
        edits: "idgaf",
        builtin: { ...NO_CHECKS, "protect-policy-files": true },
      }),
    ).toMatchObject({ policy: ASK });
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

  it("another area at Permissive does not free a file edit", () => {
    const r = write(createNewFileTool, OUTSIDE, {
      edits: "cautious",
      tools: "permissive",
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
  it("only the outside-paths check decides, whatever the levels", () => {
    const checks = (builtin?: Record<string, boolean>) =>
      ({ ...(builtin ? { builtin } : {}) }) as never;
    // The IDGAF preset leaves no check on
    expect(
      editsAllowOutsideWorkspace({ builtin: builtinForPreset("idgaf") }),
    ).toBe(true);
    // Turning only that check off is enough
    expect(
      editsAllowOutsideWorkspace(checks({ "ask-outside-paths": false })),
    ).toBe(true);
    // On, or not mentioned, it is not allowed
    expect(editsAllowOutsideWorkspace(checks())).toBe(false);
    expect(
      editsAllowOutsideWorkspace(checks({ "ask-outside-paths": true })),
    ).toBe(false);
    // Another check off does not free a path
    expect(
      editsAllowOutsideWorkspace(checks({ "ask-large-change": false })),
    ).toBe(false);
    // A host without settings allows nothing extra
    expect(editsAllowOutsideWorkspace(undefined)).toBe(false);
    // 'A few on' leaves the outside-paths check off; 'All on' keeps it
    expect(
      editsAllowOutsideWorkspace({ builtin: builtinForDegree("few") }),
    ).toBe(true);
    expect(
      editsAllowOutsideWorkspace({ builtin: builtinForDegree("all") }),
    ).toBe(false);
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
