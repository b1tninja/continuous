import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createNewFileTool, readFileTool } from "../definitions";
import { resolveInputPath } from "../../util/pathResolver";
import type { IDE } from "../..";
import { evaluateToolPolicyWithRules, type EvaluateInput } from "./evaluate";
import type { PolicyLevel } from "./policy";
import { needsLink, tryLink } from "./testLinks";

const ASK = "allowedWithPermission";
const ALLOW = "allowedWithoutPermission";
const OFF = "disabled";

function run(
  tool: typeof readFileTool,
  filepath: string,
  opts: {
    level?: PolicyLevel;
    within?: boolean;
    resolved?: string;
    platform?: "win32" | "posix";
    builtin?: Record<string, boolean>;
    permissions?: EvaluateInput["permissions"];
  } = {},
) {
  const level = opts.level ?? "permissive";
  const resolved = opts.resolved ?? `/home/me/proj/${filepath}`;
  return evaluateToolPolicyWithRules({
    tool,
    toolName: tool.function.name,
    basePolicy: tool.defaultToolPolicy,
    parsedArgs: { filepath },
    processedArgs: {
      resolvedPath: {
        uri: pathToFileURL(resolved).href,
        displayPath: filepath,
        isAbsolute: false,
        isWithinWorkspace: opts.within ?? true,
      },
    },
    permissions: opts.permissions,
    cwd: "/home/me/proj",
    shell: "bash",
    platform: opts.platform ?? "posix",
    home: "/home/me",
    approval: {
      levels: {
        context: level,
        tools: level,
        edits: level,
        plan: level,
        questions: level,
      },
      ...(opts.builtin ? { builtin: opts.builtin } : {}),
    },
  } as EvaluateInput);
}

describe("the confused-deputy rule in the evaluator", () => {
  it("lets an ordinary file in the workspace run at Permissive", () => {
    expect(run(readFileTool, "src/a.ts").policy).toBe(ALLOW);
    expect(run(createNewFileTool, "src/new.ts").policy).toBe(ALLOW);
  });

  it("asks for a write outside the workspace at Permissive, which used to run", () => {
    const r = run(createNewFileTool, "/srv/data/x.txt", {
      within: false,
      resolved: "/srv/data/x.txt",
    });
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("protected-path");
    expect(r.protection).toBe("file-deputy");
    expect(r.reason).toContain("outside the workspace");
  });

  it("asks when a link inside the workspace leads outside it", () => {
    const r = run(createNewFileTool, "link/out.txt", {
      within: false,
      resolved: "/etc/cron.d/out.txt",
    });
    expect(r.policy).toBe(ASK);
    expect(r.protection).toBe("file-deputy");
  });

  it("asks for every access to a device path, stream and the global folder", () => {
    for (const [file, platform] of [
      ["NUL", "win32"],
      ["notes.txt:hidden", "win32"],
      ["//evil/share/a.txt", "win32"],
      ["/dev/stdin", "posix"],
      ["~/.continue/config.yaml", "posix"],
      ["~root/.profile", "posix"],
    ] as const) {
      for (const tool of [readFileTool, createNewFileTool]) {
        const r = run(tool, file, { platform });
        expect(r.policy, `${tool.function.name} ${file}`).toBe(ASK);
        expect(r.protection).toBeDefined();
      }
    }
  });

  it("is not read as a Windows spelling on POSIX", () => {
    expect(
      run(readFileTool, "notes.txt:hidden", { platform: "posix" }).policy,
    ).toBe(ALLOW);
  });

  it("asks at Automatic and Cautious too, and never goes to the reviewer", () => {
    for (const level of ["automatic", "cautious"] as const) {
      const r = run(readFileTool, "/srv/x", {
        level,
        within: false,
        resolved: "/srv/x",
      });
      expect(r.policy).toBe(ASK);
      expect(r.source).toBe("protected-path");
    }
  });

  it("IDGAF is the one level that reaches past it", () => {
    const r = run(readFileTool, "/srv/x", {
      level: "idgaf",
      within: false,
      resolved: "/srv/x",
    });
    expect(r.policy).toBe(ALLOW);
  });

  it("an allow rule does not loosen it, and a deny rule still refuses", () => {
    const out = { within: false, resolved: "/srv/x" };
    expect(
      run(readFileTool, "/srv/x", {
        ...out,
        permissions: { allow: ["readFile(**)"] },
      }).policy,
    ).toBe(ASK);
    expect(
      run(readFileTool, "/srv/x", {
        ...out,
        permissions: { deny: ["readFile(/srv/**)"] },
      }).policy,
    ).toBe(OFF);
  });

  it("only the person's own builtin switch loosens the workspace boundary", () => {
    const out = { within: false, resolved: "/srv/x" };
    const off = { "ask-outside-paths": false };
    expect(
      run(createNewFileTool, "/srv/x", { ...out, builtin: off }).policy,
    ).toBe(ALLOW);
    // The floors have no switch.
    expect(
      run(readFileTool, "NUL", { platform: "win32", builtin: off }).policy,
    ).toBe(ASK);
    expect(
      run(readFileTool, "~/.continue/config.yaml", { builtin: off }).policy,
    ).toBe(ASK);
  });
});

describe("the jail-makes-a-symlink shape, on the real file system", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "deputy-"));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "target.txt"), "x");
  // A junction needs no privilege on Windows; elsewhere it is a plain link.
  const link = tryLink(outside, path.join(ws, "link"));
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  const ide = {
    getWorkspaceDirs: async () => [pathToFileURL(ws).href],
    fileExists: async (uri: string) => fs.existsSync(new URL(uri)),
  } as unknown as IDE;

  it.skipIf(!link.ok).each([
    ["write", createNewFileTool],
    ["read", readFileTool],
  ] as const)(
    needsLink("a %s through the link asks", link),
    async (_, tool) => {
      const resolved = await resolveInputPath(ide, "link/target.txt");
      expect(resolved?.isWithinWorkspace).toBe(false);
      const r = evaluateToolPolicyWithRules({
        tool,
        toolName: tool.function.name,
        basePolicy: tool.defaultToolPolicy,
        parsedArgs: { filepath: "link/target.txt" },
        processedArgs: { resolvedPath: resolved },
        permissions: undefined,
        cwd: ws,
        shell: "bash",
        approval: {
          levels: {
            context: "permissive",
            tools: "permissive",
            edits: "permissive",
            plan: "permissive",
            questions: "permissive",
          },
        },
      } as EvaluateInput);
      expect(r.policy).toBe(ASK);
      expect(r.protection).toBe("file-deputy");
    },
  );
});
