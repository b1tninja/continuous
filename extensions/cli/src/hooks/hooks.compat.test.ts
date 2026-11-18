/**
 * Compatibility with Claude Code's hooks files and the lifecycle events:
 * `onFailure` as a spelling of `onError`, the fail-closed default, masking of
 * hook input, the cap on added context, `managedHooksOnly`, and the input each
 * lifecycle event sends.
 *
 * Hooks here are `node <script>` so the same tests run on Windows and Unix.
 * Nothing calls a model.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { loadHooksConfig } from "./hookConfig.js";
import { capAdditionalContext, failureLetsActionThrough } from "./hookInput.js";
import { runHooks } from "./hookRunner.js";
import { setTrustProjectHooksForRun } from "./hookTrust.js";
import {
  notifyAttention,
  resetSessionEndForTests,
  runPreCompactHooks,
  runSessionEndHooks,
  runSessionStartHooks,
  runTurnWithStopHooks,
} from "./lifecycleHooks.js";
import { MAX_ADDITIONAL_CONTEXT_CHARS } from "./types.js";
import type { HookHandler, HookInput, HooksConfig } from "./types.js";

let dir: string;
let liveConfig: HooksConfig = {};

// fireHook reaches the hook service and the session through these two modules.
vi.mock("../services/index.js", () => ({
  services: {
    toolPermissions: undefined,
    hooks: {
      isReady: () => true,
      fireEvent: (input: HookInput) => runHooks(liveConfig, input, dir),
    },
  },
}));
vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "sess-1" }),
}));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-compat-"));
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // On Windows a hook that outlived its timeout can still hold the folder
  }
});

function script(name: string, body: string): string {
  fs.writeFileSync(path.join(dir, `${name}.cjs`), body);
  return `node ${name}.cjs`;
}

/** A hook that writes the JSON it was sent to `<name>.json` and exits 0. */
function recorder(name: string): string {
  const out = JSON.stringify(path.join(dir, `${name}.json`));
  return script(
    name,
    `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${out},s);});`,
  );
}

function recorded(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf-8"));
}

async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const base = { session_id: "s", transcript_path: "", cwd: process.cwd() };
const preToolUse = (extra: Record<string, unknown> = {}): HookInput =>
  ({
    ...base,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_use_id: "t",
    ...extra,
  }) as HookInput;

const on = (
  event: keyof HooksConfig,
  ...hooks: HookHandler[]
): HooksConfig => ({ [event]: [{ hooks }] });

const failing = () => script("fail1", "process.exit(1)");

describe("onFailure is a spelling of onError", () => {
  it("keeps the default: an unset hook that fails blocks", async () => {
    const r = await runHooks(
      on("PreToolUse", { type: "command", command: failing() }),
      preToolUse(),
      dir,
    );
    expect(r.blocked).toBe(true);
  });

  it('onFailure "continue" lets a failed hook through', async () => {
    const r = await runHooks(
      on("PreToolUse", {
        type: "command",
        command: failing(),
        onFailure: "continue",
      }),
      preToolUse(),
      dir,
    );
    expect(r.blocked).toBe(false);
    expect(r.results[0].failed).toBe(true);
  });

  it('onFailure "block" blocks', async () => {
    const r = await runHooks(
      on("PreToolUse", {
        type: "command",
        command: failing(),
        onFailure: "block",
      }),
      preToolUse(),
      dir,
    );
    expect(r.blocked).toBe(true);
  });

  it("a value that is not understood blocks", () => {
    expect(
      failureLetsActionThrough({
        type: "command",
        command: "x",
        onFailure: "allow" as never,
      }),
    ).toBe(false);
  });

  it("when both are set the stricter one wins", () => {
    const h = (onError: "allow" | "block", onFailure: "continue" | "block") =>
      failureLetsActionThrough({
        type: "command",
        command: "x",
        onError,
        onFailure,
      });
    expect(h("allow", "continue")).toBe(true);
    expect(h("allow", "block")).toBe(false);
    expect(h("block", "continue")).toBe(false);
  });

  it("a timeout blocks by default and passes with onFailure continue", async () => {
    const slow = script("slow", "setTimeout(()=>{}, 4000)");
    const blocked = await runHooks(
      on("PreToolUse", { type: "command", command: slow, timeout: 1 }),
      preToolUse(),
      dir,
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockReason).toContain("timed out");
    const passed = await runHooks(
      on("PreToolUse", {
        type: "command",
        command: slow,
        timeout: 1,
        onFailure: "continue",
      }),
      preToolUse(),
      dir,
    );
    expect(passed.blocked).toBe(false);
  }, 15_000);

  it("exit 2 stays a block whatever onFailure says", async () => {
    const deny = script("deny2", 'console.error("no"); process.exit(2)');
    const r = await runHooks(
      on("PreToolUse", {
        type: "command",
        command: deny,
        onFailure: "continue",
      }),
      preToolUse(),
      dir,
    );
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toBe("no");
  });
});

describe("hook input is masked on the way to a project hook", () => {
  const secret = `AKIA${"Z7Q4MNB2XK5LRTHW"}`;
  const input = () =>
    preToolUse({ tool_input: { command: `export K=${secret}` } });

  it("a project hook sees a placeholder, the user's own hook the value", async () => {
    await runHooks(
      on("PreToolUse", {
        type: "command",
        command: recorder("masked-project"),
        origin: "project",
      }),
      input(),
      dir,
    );
    await runHooks(
      on("PreToolUse", { type: "command", command: recorder("masked-user") }),
      input(),
      dir,
    );
    await waitFor(path.join(dir, "masked-project.json"));
    await waitFor(path.join(dir, "masked-user.json"));
    const projectSaw = JSON.stringify(recorded("masked-project"));
    expect(projectSaw).not.toContain(secret);
    expect(projectSaw).toContain("[REDACTED:");
    expect(JSON.stringify(recorded("masked-user"))).toContain(secret);
  });
});

describe("the cap on added context", () => {
  it("cuts long context and says so", () => {
    const text = "x".repeat(MAX_ADDITIONAL_CONTEXT_CHARS + 500);
    const capped = capAdditionalContext(text);
    expect(capped.startsWith("x".repeat(MAX_ADDITIONAL_CONTEXT_CHARS))).toBe(
      true,
    );
    expect(capped).toContain("truncated");
    expect(capAdditionalContext("short")).toBe("short");
  });

  it("applies to what hooks return", async () => {
    const big = script(
      "big",
      'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"y".repeat(50000)}}))',
    );
    const r = await runHooks(
      on("UserPromptSubmit", { type: "command", command: big }),
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "p" },
      dir,
    );
    expect(r.additionalContext!.length).toBeLessThan(
      MAX_ADDITIONAL_CONTEXT_CHARS + 200,
    );
    expect(r.additionalContext).toContain("truncated");
  });
});

describe("managedHooksOnly", () => {
  let root: string;
  let home: string;
  let project: string;
  let savedGlobalDir: string | undefined;
  let savedGlobalDir2: string | undefined;

  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const hook = (command: string): HooksConfig =>
    on("PreToolUse", { type: "command", command });

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "hooks-managed-")),
    );
    home = path.join(root, "home");
    project = path.join(root, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    savedGlobalDir = process.env.CONTINUE_GLOBAL_DIR;
    savedGlobalDir2 = process.env.CONTINUOUS_GLOBAL_DIR;
    delete process.env.CONTINUE_GLOBAL_DIR;
    delete process.env.CONTINUOUS_GLOBAL_DIR;
    setTrustProjectHooksForRun(false);
    write(path.join(project, ".continue", "settings.json"), {
      hooks: hook("project-hook"),
    });
    // The user file here is ~/.claude/settings.json: opted in (D-023)
    write(path.join(home, ".continuous", "settings.json"), {
      hooks: { readClaudeSettings: true },
    });
  });

  afterAll(() => {
    setTrustProjectHooksForRun(false);
    if (savedGlobalDir !== undefined)
      process.env.CONTINUE_GLOBAL_DIR = savedGlobalDir;
    if (savedGlobalDir2 !== undefined)
      process.env.CONTINUOUS_GLOBAL_DIR = savedGlobalDir2;
  });

  const commands = (cfg: HooksConfig) =>
    (cfg.PreToolUse ?? []).flatMap((g) =>
      g.hooks.map((h) => (h.type === "command" ? h.command : "")),
    );

  it("without it, the project's hooks are only offered for trust", () => {
    write(path.join(home, ".claude", "settings.json"), {
      hooks: hook("user-hook"),
    });
    const loaded = loadHooksConfig(project, home);
    expect(commands(loaded.hooks)).toEqual(["user-hook"]);
    expect(loaded.untrustedProject).toBeDefined();
    expect(loaded.managedOnly).toBeUndefined();
  });

  it("with it in the user's settings, project hooks do not load, even with the trust flag", () => {
    write(path.join(home, ".claude", "settings.json"), {
      hooks: hook("user-hook"),
      managedHooksOnly: true,
    });
    setTrustProjectHooksForRun(true);
    const loaded = loadHooksConfig(project, home);
    expect(commands(loaded.hooks)).toEqual(["user-hook"]);
    expect(loaded.managedOnly).toBe(true);
    expect(loaded.untrustedProject).toBeUndefined();
  });

  it("a project file cannot switch it on", () => {
    write(path.join(home, ".claude", "settings.json"), {
      hooks: hook("user-hook"),
    });
    write(path.join(project, ".continue", "settings.json"), {
      hooks: hook("project-hook"),
      managedHooksOnly: true,
    });
    setTrustProjectHooksForRun(true);
    const loaded = loadHooksConfig(project, home);
    expect(commands(loaded.hooks).sort()).toEqual([
      "project-hook",
      "user-hook",
    ]);
    expect(loaded.managedOnly).toBeUndefined();
  });

  it("only the value true counts", () => {
    write(path.join(home, ".claude", "settings.json"), {
      managedHooksOnly: "yes",
    });
    expect(loadHooksConfig(project, home).managedOnly).toBeUndefined();
  });
});

describe("lifecycle events send Claude Code's input", () => {
  const common = (json: Record<string, unknown>, event: string) => {
    expect(json.session_id).toBe("sess-1");
    expect(json.cwd).toBe(process.cwd());
    expect(json).toHaveProperty("transcript_path");
    expect(json.hook_event_name).toBe(event);
  };

  beforeEach(() => {
    resetSessionEndForTests();
    liveConfig = {};
  });

  it("SessionStart: source and model", async () => {
    liveConfig = on("SessionStart", {
      type: "command",
      command: recorder("ss"),
    });
    await runSessionStartHooks("resume", "some-model");
    const json = recorded("ss");
    common(json, "SessionStart");
    expect(json.source).toBe("resume");
    expect(json.model).toBe("some-model");
  });

  it("SessionEnd: reason, and once only", async () => {
    liveConfig = on("SessionEnd", { type: "command", command: recorder("se") });
    await runSessionEndHooks("prompt_input_exit");
    common(recorded("se"), "SessionEnd");
    expect(recorded("se").reason).toBe("prompt_input_exit");
    fs.rmSync(path.join(dir, "se.json"));
    await runSessionEndHooks("other");
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(path.join(dir, "se.json"))).toBe(false);
  });

  it("SessionEnd does not hold the exit past its budget", async () => {
    liveConfig = on("SessionEnd", {
      type: "command",
      command: script("slowEnd", "setTimeout(()=>{}, 4000)"),
      timeout: 30,
    });
    const started = Date.now();
    await runSessionEndHooks("other", 200);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("Stop: stop_hook_active false and the last message", async () => {
    liveConfig = on("Stop", { type: "command", command: recorder("st") });
    await runTurnWithStopHooks({
      runTurn: async () => "all done",
      addUserMessage: () => {},
      notice: () => {},
    });
    const json = recorded("st");
    common(json, "Stop");
    expect(json.stop_hook_active).toBe(false);
    expect(json.last_assistant_message).toBe("all done");
  });

  it("Stop: a hook that keeps asking to continue ends with a notice", async () => {
    liveConfig = on("Stop", {
      type: "command",
      command: script(
        "stopBlock",
        'console.error("keep going"); process.exit(2)',
      ),
    });
    const notices: string[] = [];
    await expect(
      runTurnWithStopHooks({
        runTurn: async () => "x",
        addUserMessage: () => {},
        notice: (text) => notices.push(text),
      }),
    ).resolves.toBe("x");
    expect(notices).toHaveLength(1);
  });

  it("Notification: message, title and notification_type", async () => {
    liveConfig = on("Notification", {
      type: "command",
      command: recorder("nt"),
    });
    notifyAttention(
      "Approval needed for Bash",
      "permission_prompt",
      "Permission needed",
    );
    await waitFor(path.join(dir, "nt.json"));
    const json = recorded("nt");
    common(json, "Notification");
    expect(json.message).toBe("Approval needed for Bash");
    expect(json.title).toBe("Permission needed");
    expect(json.notification_type).toBe("permission_prompt");
  });

  it("PreCompact: trigger and custom_instructions", async () => {
    liveConfig = on("PreCompact", { type: "command", command: recorder("pc") });
    await runPreCompactHooks("auto");
    const json = recorded("pc");
    common(json, "PreCompact");
    expect(json.trigger).toBe("auto");
    expect(json.custom_instructions).toBeNull();
  });

  it("PermissionRequest: tool_name and tool_input; a deny blocks", async () => {
    const { firePermissionRequest } = await import("./fireHook.js");
    liveConfig = on("PermissionRequest", {
      type: "command",
      command: recorder("pr"),
    });
    await firePermissionRequest("Bash", { command: "rm x" });
    const json = recorded("pr");
    common(json, "PermissionRequest");
    expect(json.tool_name).toBe("Bash");
    expect(json.tool_input).toEqual({ command: "rm x" });

    liveConfig = on("PermissionRequest", {
      type: "command",
      command: script(
        "prDeny",
        'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"deny",message:"no"}}}))',
      ),
    });
    const denied = await firePermissionRequest("Bash", {});
    expect(denied.blocked).toBe(true);
  });
});
