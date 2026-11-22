import fs from "fs";

import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import {
  suggestAllowRule,
  withLoosensCheck,
} from "core/tools/permissions/suggest.js";
import {
  secretReads,
  taintRegistry,
} from "core/tools/permissions/taint/taintState.js";
import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AskWhy } from "../../permissions/askWhy.js";
import { noteCliToolResult } from "../../permissions/cliTaint.js";
import { suggestRuleForCall } from "../../permissions/explainAsk.js";
import { toolPermissionManager } from "../../permissions/permissionManager.js";
import { PERMISSIONS_YAML_PATH } from "../../permissions/permissionsYamlLoader.js";
import { resolvePermissionPrecedence } from "../../permissions/precedenceResolver.js";
import type { ToolPermissions } from "../../permissions/types.js";
import { checkToolPermissionApproval } from "../../stream/streamChatResponse.helpers.js";
import { createStreamCallbacks } from "../hooks/useChat.stream.helpers.js";
import type { ActivePermissionRequest } from "../hooks/useChat.types.js";

import { ToolPermissionSelector } from "./ToolPermissionSelector.js";

const state = vi.hoisted(() => ({
  model: { assistant: undefined as any, authConfig: {} as any },
  taintRule: "off" as "off" | "ask",
  columns: 100,
}));

vi.mock("../../services/index.js", () => ({
  SERVICE_NAMES: { MODEL: "model", TOOL_PERMISSIONS: "toolPermissions" },
  serviceContainer: {
    get: vi.fn(async () => state.model),
    getSync: vi.fn(() => ({ value: state.model })),
  },
  services: { chatHistory: { getHistory: () => [] } },
}));
vi.mock("core/tools/permissions/taint/taintSetting.js", () => ({
  readTaintedSessionRule: () => state.taintRule,
  parseTaintedSessionRule: (v: unknown) => (v === "ask" ? "ask" : "off"),
}));
vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({
    columns: state.columns,
    rows: 24,
    isResizing: false,
  }),
}));

const bashCheck = (base: any, args: any) =>
  evaluateTerminalCommandSecurity(base, args.command);

const bash = (command: string, tool: object = {}): any => ({
  id: "1",
  name: "Bash",
  arguments: { command },
  argumentsStr: JSON.stringify({ command }),
  tool,
});

const allowAll: ToolPermissions = {
  policies: [{ tool: "*", permission: "allow" }],
};

/**
 * Runs the call through the real approval path and returns what the prompt
 * was handed: the same object the terminal UI keeps and renders.
 */
async function askedWith(
  permissions: ToolPermissions,
  call: any,
): Promise<AskWhy | undefined> {
  let why: AskWhy | undefined;
  // The terminal UI's own callbacks: what they keep is what the prompt renders
  const setActivePermissionRequest = vi.fn(
    (request: ActivePermissionRequest) => {
      why = request.why;
      toolPermissionManager.rejectRequest(request.requestId);
    },
  );
  const callbacks = createStreamCallbacks({
    setChatHistory: vi.fn(),
    setActivePermissionRequest: setActivePermissionRequest as never,
  });
  await checkToolPermissionApproval(permissions, call, callbacks, false);
  expect(setActivePermissionRequest).toHaveBeenCalledTimes(1);
  return why;
}

function prompt(call: any, why: AskWhy | undefined, width?: number) {
  const selector = (
    <ToolPermissionSelector
      toolName={call.name}
      toolArgs={call.arguments}
      requestId="r1"
      why={why}
      onResponse={() => {}}
    />
  );
  return render(width ? <Box width={width}>{selector}</Box> : selector);
}

function frameOf(call: any, why: AskWhy | undefined, width?: number): string {
  const { lastFrame, unmount } = prompt(call, why, width);
  const out = lastFrame() ?? "";
  unmount();
  return out;
}

/** The frame as one line of text, so a wrapped sentence can be searched for. */
const flat = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.replace(/^[│\s]+|[│\s]+$/g, ""))
    .join(" ");

beforeEach(() => {
  state.model = { assistant: undefined, authConfig: {} };
  state.taintRule = "off";
  state.columns = 100;
  taintRegistry.reset();
  secretReads.reset();
});

afterEach(() => {
  fs.rmSync(PERMISSIONS_YAML_PATH, { force: true });
});

describe("the approval prompt says why it asks and where that was decided", () => {
  it("a protected path: the engine's reason and the built-in check with its id", async () => {
    const call = bash("cat .env", { evaluateToolCallPolicy: bashCheck });
    const why = await askedWith(allowAll, call);
    expect(why?.source.what).toBe(
      'the built-in check "Ask before touching credentials" (protect-secrets)',
    );

    const frame = frameOf(call, why);
    expect(flat(frame)).toContain(`Why: ${why!.reason}`);
    expect(frame).toContain(
      'From: the built-in check "Ask before touching credentials" (protect-secrets)',
    );
  });

  it("an ask rule in permissions.yaml: the rule as written and the file it is in", async () => {
    fs.writeFileSync(PERMISSIONS_YAML_PATH, "ask:\n  - Bash(npm publish*)\n");
    const permissions = {
      policies: resolvePermissionPrecedence({ personalSettings: true }),
    };
    const call = bash("npm publish --tag next");
    const why = await askedWith(permissions, call);
    expect(why?.source).toEqual({
      what: "your ask rule",
      rule: "Bash(npm publish*)",
      file: PERMISSIONS_YAML_PATH,
    });

    state.columns = 200;
    const frame = frameOf(call, why, 200);
    expect(frame).toContain(
      "Why: Your rule Bash(npm publish*) asks before running this.",
    );
    expect(frame).toContain(
      `From: your ask rule Bash(npm publish*) in ${PERMISSIONS_YAML_PATH}`,
    );
  });

  it("an ask rule in config.yaml: the engine's sentence and whose configuration it is", async () => {
    state.model.assistant = {
      toolPermissions: { ask: ["runTerminalCommand(git push*)"] },
    };
    const call = bash("git push");
    const why = await askedWith(allowAll, call);

    state.columns = 200;
    const frame = frameOf(call, why, 200);
    expect(flat(frame)).toContain(`Why: ${why!.reason}`);
    expect(why!.reason).toContain("runTerminalCommand(git push*)");
    expect(frame).toContain(
      "From: the toolPermissions.ask rule runTerminalCommand(git push*) in the assistant configuration",
    );
  });

  it("a tainted session: the reason names the content and the check is named with its id", async () => {
    state.taintRule = "ask";
    noteCliToolResult(
      { id: "c1", name: "Fetch", arguments: { url: "https://a.example/page" } },
      undefined,
    );
    const call = bash("git push origin main");
    const why = await askedWith(allowAll, call);
    expect(why?.reason).toContain("Untrusted content (web-fetch)");

    const frame = frameOf(call, why);
    expect(flat(frame)).toContain("Why: Untrusted content (web-fetch)");
    expect(frame).toContain(
      "From: the check for untrusted content in this session (tainted-session)",
    );
    // Short while deciding: the whole sentence is behind the detail key
    expect(flat(frame)).not.toContain(why!.reason);
    expect(flat(frame)).toMatch(/Why: Untrusted content .*…/);
    expect(frame).toContain("r: full reason");
  });

  it("without a reason to show, the prompt is what it was", () => {
    const frame = frameOf(bash("npm test"), undefined);
    expect(frame).not.toContain("Why:");
    expect(frame).not.toContain("From:");
    expect(frame).toContain("Would you like to continue?");
    expect(frame).not.toContain("r:");
  });

  it("a warning the engine put in the preview is shown once, and whole", () => {
    const reason = `This looks like bash; it runs in Windows PowerShell 5.1. ${"The && operator is not supported there. ".repeat(6)}Instead: use a semicolon.`;
    const why: AskWhy = {
      reason,
      source: {
        what: "the check that a command fits the shell it runs in (shell-hint)",
      },
      suggestion: { ok: false, reason: "No rule." },
      ruleStopsAsk: false,
    };
    const { lastFrame, unmount } = render(
      <ToolPermissionSelector
        toolName="Bash"
        toolArgs={{ command: "a && b" }}
        requestId="r1"
        toolCallPreview={[{ type: "text", content: reason, color: "yellow" }]}
        why={why}
        onResponse={() => {}}
      />,
    );
    const out = flat(lastFrame() ?? "");
    unmount();
    expect(out).toContain(`Why: ${reason}`);
    expect(out.split("Instead: use a semicolon.")).toHaveLength(2);
  });
});

describe("the detail key previews the rule that would allow the call", () => {
  const press = async (stdin: { write: (s: string) => void }, key: string) => {
    await new Promise((r) => setTimeout(r, 20));
    stdin.write(key);
    await new Promise((r) => setTimeout(r, 20));
  };

  it("is the rule the IDE's Always allow suggests for the same call", async () => {
    const tool = { evaluateToolCallPolicy: bashCheck };
    const call = bash("npm test", tool);
    const ide = withLoosensCheck(
      suggestAllowRule({
        toolName: "run_terminal_command",
        parsedArgs: { command: "npm test" },
      }),
      tool,
      { command: "npm test" },
    );
    expect(ide).toMatchObject({ ok: true });
    expect(suggestRuleForCall("Bash", { command: "npm test" }, tool)).toEqual(
      ide,
    );

    const askAll: ToolPermissions = {
      policies: [{ tool: "*", permission: "ask" }],
    };
    const why = await askedWith(askAll, call);
    expect(why?.suggestion).toEqual(ide);

    const onResponse = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <ToolPermissionSelector
        toolName="Bash"
        toolArgs={call.arguments}
        requestId="r1"
        why={why}
        onResponse={onResponse}
      />,
    );
    expect(lastFrame()).not.toContain("Narrowest allow rule");
    await press(stdin, "r");
    const open = lastFrame() ?? "";
    expect(open).toContain(
      `Narrowest allow rule for this call: ${(ide as { rule: string }).rule}`,
    );
    expect(open).toContain("It allows this exact command.");
    // Looking is not answering, and nothing is saved
    expect(onResponse).not.toHaveBeenCalled();
    expect(fs.existsSync(PERMISSIONS_YAML_PATH)).toBe(false);

    await press(stdin, "r");
    expect(lastFrame()).not.toContain("Narrowest allow rule");
    unmount();
  });

  it("says so when no rule can allow the call, in the IDE's words", async () => {
    const call = bash("cat .env", { evaluateToolCallPolicy: bashCheck });
    const ide = suggestAllowRule({
      toolName: "run_terminal_command",
      parsedArgs: { command: "cat .env" },
    });
    expect(ide.ok).toBe(false);
    const why = await askedWith(allowAll, call);
    expect(why?.suggestion).toEqual(ide);

    const { lastFrame, stdin, unmount } = prompt(call, why);
    await press(stdin, "r");
    expect(flat(lastFrame() ?? "")).toContain(
      `No allow rule can be written for this call: ${(ide as { reason: string }).reason}`,
    );
    unmount();
  });

  it("the whole reason and source are in the detail when the short lines cut them", async () => {
    state.taintRule = "ask";
    noteCliToolResult(
      { id: "c1", name: "Fetch", arguments: { url: "https://a.example/page" } },
      undefined,
    );
    const call = bash("git push origin main");
    const why = await askedWith(allowAll, call);
    const { lastFrame, stdin, unmount } = prompt(call, why);
    await press(stdin, "r");
    const open = flat(lastFrame() ?? "");
    expect(open).toContain(why!.reason);
    expect(open).toContain("this rule alone would not stop the ask");
    unmount();
  });
});

describe("the prompt at 80 columns", () => {
  it("keeps the command on screen and every line inside the terminal", async () => {
    const pattern =
      "npm publish --registry https://registry.internal.example.com/a/long/path/to/a/private/registry/*";
    fs.writeFileSync(PERMISSIONS_YAML_PATH, `ask:\n  - Bash(${pattern})\n`);
    const permissions = {
      policies: resolvePermissionPrecedence({ personalSettings: true }),
    };
    const call = bash(
      "npm publish --registry https://registry.internal.example.com/a/long/path/to/a/private/registry/pkg",
    );
    const why = await askedWith(permissions, call);
    expect(why?.source.rule).toBe(`Bash(${pattern})`);

    state.columns = 80;
    const frame = frameOf(call, why, 80);
    const lines = frame.split("\n");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    // The command being approved: the title is still the first line in the box
    expect(lines[2]).toContain("npm publish --registry");
    expect(lines.length).toBeLessThanOrEqual(24);

    // The long rule and path are cut in the middle, on one line
    const from = lines.filter((l) => l.includes("From:"));
    expect(from).toHaveLength(1);
    expect(from[0]).toContain("your ask rule Bash(npm pub");
    expect(from[0]).toMatch(/….*registry\/\*\) in .*….*permissions\.yaml/);
    // So is the rule the reason quotes: the sentence still ends, on one line
    const whyLine = lines.find((l) => l.includes("Why:")) ?? "";
    expect(whyLine).toMatch(
      /Why: Your rule Bash\(npm.*….*asks before running this\./,
    );
    expect(lines.indexOf(from[0]) - lines.indexOf(whyLine)).toBe(1);
  });
});
