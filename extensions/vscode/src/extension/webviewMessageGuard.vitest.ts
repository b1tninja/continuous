import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isInsideWorkspace,
  openUrlFromWebviewOk,
  policySavePayloadOk,
  DENIED_FROM_WEBVIEW,
  refuseFromWebview,
  runCommandFromWebviewOk,
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

describe("runCommandFromWebviewOk", () => {
  it("requires a string command", () => {
    expect(runCommandFromWebviewOk({ command: "npm test" })).toBe(true);
    expect(runCommandFromWebviewOk({ command: 1 })).toBe(false);
    expect(runCommandFromWebviewOk("npm test")).toBe(false);
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
