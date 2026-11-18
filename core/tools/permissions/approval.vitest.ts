import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import type { ApprovalSettings } from "./approval";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { DEFAULT_POLICY_LEVELS, PolicyLevels } from "./policy";

const ASK = "allowedWithPermission" as const;
const ALLOW = "allowedWithoutPermission" as const;
const OFF = "disabled" as const;

const terminalTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    evaluateTerminalCommandSecurity(base, args.command as string),
};
/** Asks for a file outside the workspace, like evaluateFileAccessPolicy. */
const readTool = {
  group: "Built-In",
  evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
    base === OFF
      ? OFF
      : String(args.filepath).startsWith("/outside")
        ? ASK
        : base,
};
const mcpTool = (group: string, readonly = false) => ({
  group,
  uri: `mcp://${group}`,
  originalFunctionName: "query",
  readonly,
});
const plain = { group: "Built-In" };

/** The defaults, with the named areas changed. */
const levels = (over: Partial<PolicyLevels>): ApprovalSettings => ({
  levels: { ...DEFAULT_POLICY_LEVELS, ...over },
});

const approve = (
  toolName: string,
  tool: any,
  parsedArgs: Record<string, unknown>,
  approval: ApprovalSettings | undefined,
  extra: { permissions?: any; basePolicy?: any } = {},
) =>
  evaluateToolPolicyWithRules({
    tool,
    toolName,
    basePolicy: extra.basePolicy ?? ASK,
    parsedArgs,
    permissions: extra.permissions,
    approval,
    shell: "bash",
  });

const cmd = (
  command: string,
  approval: ApprovalSettings | undefined,
  extra?: { permissions?: any; basePolicy?: any },
) =>
  approve("run_terminal_command", terminalTool, { command }, approval, extra);

const read = (
  filepath: string,
  approval: ApprovalSettings | undefined,
  extra?: { permissions?: any; basePolicy?: any },
) => approve("read_file", readTool, { filepath }, approval, extra);

describe("Cautious (and no levels at all) changes nothing", () => {
  it("leaves an ask as an ask", () => {
    expect(cmd("npm test", undefined).policy).toBe(ASK);
    expect(cmd("npm test", levels({ tools: "cautious" })).policy).toBe(ASK);
    expect(cmd("npm test", levels({ tools: "automatic" })).policy).toBe(ASK);
  });
  it("leaves a call the tool setting allows as allowed", () => {
    expect(
      cmd("ls", levels({ tools: "cautious" }), { basePolicy: ALLOW }).policy,
    ).toBe(ALLOW);
  });
  it("honours an allow rule", () => {
    const r = cmd("npm test", levels({ tools: "cautious" }), {
      permissions: { allow: ["runTerminalCommand(npm test)"] },
    });
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("allow-rule");
  });
});

describe("each area has its own level", () => {
  it("Tool use Permissive does not loosen reads", () => {
    const a = levels({ tools: "permissive", context: "manual" });
    expect(cmd("git push", a).policy).toBe(ALLOW);
    expect(read("src/a.ts", a, { basePolicy: ALLOW }).policy).toBe(ASK);
  });
  it("Context use IDGAF does not loosen commands", () => {
    const a = levels({ context: "idgaf", tools: "manual" });
    expect(read("/outside/x", a).policy).toBe(ALLOW);
    expect(cmd("npm test", a, { basePolicy: ALLOW }).policy).toBe(ASK);
  });
  it("a session tool belongs to no area", () => {
    const a = levels({ context: "manual", tools: "manual" });
    expect(
      approve("task_list", plain, {}, a, { basePolicy: ALLOW }).policy,
    ).toBe(ALLOW);
  });
  it("an MCP tool is Tool use, or Context use when it is read-only", () => {
    const a = levels({ tools: "permissive", context: "manual" });
    expect(approve("query", mcpTool("db"), {}, a).policy).toBe(ALLOW);
    expect(approve("query", mcpTool("db", true), {}, a).policy).toBe(ASK);
  });
});

describe("Manual asks every time", () => {
  const manual = levels({ tools: "manual", context: "manual" });

  it("asks for a call the tool setting allows", () => {
    const r = cmd("ls", manual, { basePolicy: ALLOW });
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("manual");
    expect(read("src/a.ts", manual, { basePolicy: ALLOW }).policy).toBe(ASK);
  });
  it("does not consult an allow rule", () => {
    const r = cmd("npm test", manual, {
      permissions: { allow: ["runTerminalCommand(npm test)"] },
    });
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("manual");
  });
  it("still honours deny rules and the safety floor", () => {
    const deny = cmd("terraform apply", manual, {
      permissions: { deny: ["runTerminalCommand(terraform apply*)"] },
    });
    expect(deny.policy).toBe(OFF);
    expect(deny.source).toBe("deny-rule");
    expect(cmd("rm -rf /", manual).policy).toBe(OFF);
  });
  it("does not turn on a tool the user switched off", () => {
    expect(cmd("ls", manual, { basePolicy: OFF }).policy).toBe(OFF);
  });
  it("leaves File edits to the diff review", () => {
    const e = approve(
      "edit_existing_file",
      plain,
      { filepath: "src/a.ts" },
      levels({ edits: "manual" }),
      { basePolicy: ALLOW },
    );
    expect(e.policy).toBe(ALLOW);
  });
});

describe("Permissive", () => {
  const permissive = levels({ tools: "permissive", context: "permissive" });

  it("allows what would have asked, naming the level", () => {
    const r = cmd("git push origin main", permissive);
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("permissive");
  });
  it("still refuses what the safety floor refuses", () => {
    const r = cmd("rm -rf /", permissive);
    expect(r.policy).toBe(OFF);
    expect(r.source).not.toBe("permissive");
  });
  it("still honours deny rules and ask rules", () => {
    const r = cmd("terraform apply", permissive, {
      permissions: { deny: ["runTerminalCommand(terraform apply*)"] },
    });
    expect(r.policy).toBe(OFF);
    expect(r.source).toBe("deny-rule");
    const ask = cmd("git push", permissive, {
      permissions: { ask: ["runTerminalCommand(git push*)"] },
    });
    expect(ask.policy).toBe(ASK);
    expect(ask.source).toBe("ask-rule");
  });
  it("still honours protected paths for commands and files", () => {
    expect(cmd("cat ~/.aws/credentials", permissive).source).toBe(
      "protected-path",
    );
    expect(cmd("cat .env", permissive).policy).toBe(ASK);
    const e = approve(
      "edit_existing_file",
      plain,
      { filepath: ".git/hooks/pre-commit" },
      levels({ edits: "permissive" }),
    );
    expect(e.source).toBe("protected-path");
  });
  it("does not turn on a tool the user switched off", () => {
    expect(cmd("npm test", permissive, { basePolicy: OFF }).policy).toBe(OFF);
  });
  it("keeps a read outside the workspace asking", () => {
    expect(read("/outside/x", permissive).policy).toBe(ASK);
    expect(read("src/a.ts", permissive).policy).toBe(ALLOW);
  });
});

describe("obfuscated commands the safety floor cannot see", () => {
  const handsOff = levels({
    tools: "permissive",
    context: "permissive",
    edits: "permissive",
    plan: "permissive",
    questions: "permissive",
  });
  const idgaf = levels({
    tools: "idgaf",
    context: "idgaf",
    edits: "idgaf",
    plan: "idgaf",
    questions: "idgaf",
  });

  it.each(["{rm,-rf,~}", "rm${IFS}-rf${IFS}~", "G=rm; $G -rf ~"])(
    "does not run %s under Hands-off; IDGAF runs it and records the refusal",
    (command) => {
      expect(cmd(command, handsOff).policy).toBe(OFF);
      const r = cmd(command, idgaf);
      expect(r.policy).toBe(ALLOW);
      expect(r.source).toBe("idgaf");
      expect(r.idgafOverride?.policy).toBe(OFF);
    },
  );

  it("still runs an ordinary command under Hands-off and a clear refusal under IDGAF", () => {
    expect(cmd("git push origin main", handsOff).policy).toBe(ALLOW);
    expect(cmd("echo $HOME", handsOff).policy).toBe(ALLOW);
    expect(cmd("rm -rf /", idgaf).policy).toBe(ALLOW);
  });

  it("asks about a substitution under Hands-off; IDGAF runs it and records the ask", () => {
    expect(cmd("echo $(date)", handsOff).policy).toBe(ASK);
    const r = cmd("echo $(date)", idgaf);
    expect(r.policy).toBe(ALLOW);
    expect(r.idgafOverride?.policy).toBe(ASK);
  });
});

describe("IDGAF", () => {
  const idgaf = levels({ tools: "idgaf", context: "idgaf", edits: "idgaf" });

  it("allows everything and ignores every rule", () => {
    expect(cmd("git push", idgaf).source).toBe("idgaf");
    const deny = {
      permissions: { deny: ["runTerminalCommand(terraform apply*)"] },
    };
    expect(cmd("terraform apply", idgaf, deny).policy).toBe(ALLOW);
    expect(cmd("cat .env", idgaf).policy).toBe(ALLOW);
    expect(cmd("rm -rf /", idgaf).policy).toBe(ALLOW);
    expect(read("/outside/x", idgaf).policy).toBe(ALLOW);
  });
  it("does not turn on a tool the user switched off", () => {
    expect(cmd("npm test", idgaf, { basePolicy: OFF }).policy).toBe(OFF);
  });
});

describe("built-in rules by id", () => {
  const off = (
    id: string,
    over: Partial<PolicyLevels> = {},
  ): ApprovalSettings => ({
    ...levels(over),
    builtin: { [id]: false },
  });

  it("protect-secrets off: a credentials file no longer asks, a config path still does", () => {
    const a = off("protect-secrets", { tools: "permissive" });
    expect(cmd("cat ~/.aws/credentials", a).policy).toBe(ALLOW);
    expect(
      approve(
        "edit_existing_file",
        plain,
        { filepath: ".git/hooks/pre-commit" },
        off("protect-secrets", { edits: "permissive" }),
      ).source,
    ).toBe("protected-path");
  });

  it("protect-config off: a hook path no longer asks", () => {
    const e = approve(
      "edit_existing_file",
      plain,
      { filepath: ".git/hooks/pre-commit" },
      off("protect-config", { edits: "permissive" }),
      { basePolicy: ALLOW },
    );
    expect(e.source).not.toBe("protected-path");
  });

  it("refuse-dangerous-commands off: the safety check's refusal becomes an ask", () => {
    expect(cmd("rm -rf /", levels({})).policy).toBe(OFF);
    expect(cmd("rm -rf /", off("refuse-dangerous-commands")).policy).toBe(ASK);
  });

  it("on by default: an absent id is on", () => {
    expect(
      cmd("rm -rf /", { levels: DEFAULT_POLICY_LEVELS, builtin: {} }).policy,
    ).toBe(OFF);
  });
});

describe("the floor", () => {
  const floor = (over: Partial<PolicyLevels>): ApprovalSettings => ({
    ...levels(over),
    floor: ["runTerminalCommand(terraform destroy*)"],
  });

  it("does not bind at IDGAF: the call runs and the floor rule is recorded", () => {
    const r = cmd("terraform destroy -auto-approve", floor({ tools: "idgaf" }));
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("idgaf");
    expect(r.idgafOverride).toMatchObject({ policy: OFF, source: "floor" });
    expect(r.idgafOverride?.rule).toContain("terraform destroy");
  });

  it("leaves other commands to the level", () => {
    expect(cmd("terraform plan", floor({ tools: "idgaf" })).policy).toBe(ALLOW);
  });

  it("binds at every level below IDGAF", () => {
    for (const tools of ["manual", "cautious", "permissive"] as const) {
      expect(cmd("terraform destroy", floor({ tools })).policy).toBe(OFF);
    }
  });
});

describe("a command that only reads is Context use", () => {
  it("runs under Context Permissive while Tool use is Cautious, and says why", () => {
    const r = cmd("ls -la src", levels({}));
    expect(r.policy).toBe(ALLOW);
    expect(r.source).toBe("permissive");
    expect(r.readOnly).toBe("only reads: ls");
    expect(r.reason).toContain("Context use");
    expect(r.reason).toContain("only reads: ls");
    // A command that does not only read is still Tool use
    expect(cmd("npm test", levels({})).policy).toBe(ASK);
  });

  it("a pipeline of readers is one read", () => {
    expect(cmd("cat a.txt | sort | uniq", levels({})).policy).toBe(ALLOW);
    expect(cmd("cat a.txt | tee b.txt", levels({})).policy).toBe(ASK);
  });

  it("is decided by Context use, not Tool use", () => {
    const manualContext = levels({ context: "manual", tools: "permissive" });
    expect(cmd("ls", manualContext).policy).toBe(ASK);
    expect(cmd("ls", manualContext).source).toBe("manual");
    expect(cmd("npm test", manualContext).policy).toBe(ALLOW);
    expect(
      cmd("ls", levels({ context: "idgaf", tools: "manual" })).policy,
    ).toBe(ALLOW);
  });

  it("a redirect or substitution makes it Tool use again", () => {
    const toolsManual = levels({ tools: "manual" });
    expect(cmd("ls > out.txt", toolsManual).policy).toBe(ASK);
    expect(cmd("ls $(pwd)", toolsManual).policy).toBe(ASK);
    expect(cmd("ls", toolsManual).policy).toBe(ALLOW);
  });

  it("protected paths, deny rules and the safety check still apply to it", () => {
    expect(cmd("cat ~/.aws/credentials", levels({})).source).toBe(
      "protected-path",
    );
    const deny = cmd("cat notes.txt", levels({}), {
      permissions: { deny: ["runTerminalCommand(cat *)"] },
    });
    expect(deny.policy).toBe(OFF);
    expect(deny.source).toBe("deny-rule");
  });

  it("git is vouched only with a folder whose git config runs nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-git-"));
    try {
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(
        path.join(dir, ".git", "config"),
        "[core]\n\tfsmonitor = /tmp/x\n",
      );
      const withCwd = (cwd?: string) =>
        evaluateToolPolicyWithRules({
          tool: terminalTool as any,
          toolName: "run_terminal_command",
          basePolicy: ASK,
          parsedArgs: { command: "git status" },
          permissions: undefined,
          approval: levels({}),
          cwd,
          shell: "bash",
        });
      // No folder, or a config that can run a program: Tool use, so it asks
      expect(withCwd(undefined).policy).toBe(ASK);
      expect(withCwd(dir).policy).toBe(ASK);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a command is read in the shell that runs it", () => {
  const run = (command: string, shell?: "bash" | "powershell" | "cmd") =>
    evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command },
      permissions: undefined,
      approval: levels({}),
      shell,
    });

  it("with no shell known a read-only command is Tool use again", () => {
    expect(run("ls", "bash").policy).toBe(ALLOW);
    expect(run("ls", undefined).policy).toBe(ASK);
  });

  it("cmd vouches only its own commands: any other name may be a file in the folder", () => {
    expect(run("dir", "cmd").policy).toBe(ALLOW);
    expect(run("findstr x f.txt", "cmd").policy).toBe(ASK);
    expect(run("git status", "cmd").policy).toBe(ASK);
  });

  it("the same text is two things: date reads in bash and is not vouched in PowerShell", () => {
    expect(run("date", "bash").policy).toBe(ALLOW);
    expect(run("date", "powershell").policy).toBe(ASK);
    expect(run("Get-ChildItem src", "powershell").policy).toBe(ALLOW);
    expect(run("Get-ChildItem src", "bash").policy).toBe(ASK);
  });
});
