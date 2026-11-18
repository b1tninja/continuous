import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  editorEnvironmentDetail,
  environmentDetailOf,
  readUserEnvironmentDetail,
  resolveEnvironmentDetail,
  setEditorEnvironmentDetail,
} from "./environmentDetail";
import { editorSessionEnvironment } from "./environmentSession";
import { setSessionTerminalShell } from "./shell";

afterEach(() => {
  setEditorEnvironmentDetail(undefined);
  setSessionTerminalShell(undefined);
});

describe("environment.detail (ENV18)", () => {
  it("the person's own sources choose, in order: flag, editor, config", () => {
    expect(resolveEnvironmentDetail({})).toBe("standard");
    expect(resolveEnvironmentDetail({ user: "full" })).toBe("full");
    expect(resolveEnvironmentDetail({ user: "full", editor: "minimal" })).toBe(
      "minimal",
    );
    expect(resolveEnvironmentDetail({ flag: "full", editor: "minimal" })).toBe(
      "full",
    );
  });

  it("anything else may lower the level, never raise it", () => {
    expect(
      resolveEnvironmentDetail({ user: "full", lowerOnly: ["minimal"] }),
    ).toBe("minimal");
    expect(
      resolveEnvironmentDetail({ user: "minimal", lowerOnly: ["full"] }),
    ).toBe("minimal");
    expect(resolveEnvironmentDetail({ lowerOnly: ["full", undefined] })).toBe(
      "standard",
    );
  });

  it("reads environment.detail from the person's config.yaml, ignoring bad values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-detail-"));
    try {
      const file = path.join(dir, "config.yaml");
      fs.writeFileSync(file, "name: x\nenvironment:\n  detail: full\n");
      expect(readUserEnvironmentDetail(file)).toBe("full");
      fs.writeFileSync(file, "environment:\n  detail: everything\n");
      expect(readUserEnvironmentDetail(file)).toBeUndefined();
      expect(readUserEnvironmentDetail(path.join(dir, "none.yaml"))).toBe(
        undefined,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(environmentDetailOf({ environment: { detail: "minimal" } })).toBe(
      "minimal",
    );
    expect(environmentDetailOf(null)).toBeUndefined();
  });

  it("the editor's user value chooses; a workspace value only lowers it", () => {
    setEditorEnvironmentDetail("full", "minimal");
    expect(editorEnvironmentDetail()).toBe("minimal");
    setEditorEnvironmentDetail("minimal", "full");
    expect(editorEnvironmentDetail()).toBe("minimal");
  });
});

describe("a remote editor window (ENV15)", () => {
  const machine = {
    home: "C:\\Users\\jdoe",
    user: "jdoe",
    hostName: "laptop-1",
    addresses: [],
    arch: "x64",
    osRelease: "10.0.26100",
    timeZone: undefined,
    locale: undefined,
  };

  it("says the window is remote, reads no local git and names no local shell", async () => {
    let gitCalls = 0;
    const env = await editorSessionEnvironment({
      workspaceDirs: async () => [
        "vscode-remote://ssh-remote+box/home/alex/acme-api",
      ],
      remoteName: async () => "ssh-remote",
      gather: {
        platform: "win32",
        env: {},
        machine,
        git: async () => {
          gitCalls++;
          return "true";
        },
      },
    });
    expect(gitCalls).toBe(0);
    expect(env.strings?.systemLine).toContain(
      "Platform: not known here (this editor window is remote: ssh-remote)",
    );
    expect(env.strings?.toolSentence).not.toContain("PowerShell 5.1");
    expect(env.strings?.firstMessageBlock).toContain("on the remote machine");
    expect(env.strings?.firstMessageBlock).not.toContain("Git:");
  });

  it("the level chosen is the one the session renders at", async () => {
    const env = await editorSessionEnvironment({
      workspaceDirs: async () => ["file:///c%3A/Users/jdoe/code/acme-api"],
      detail: "minimal",
      gather: { platform: "win32", env: {}, machine, skipGit: true },
    });
    expect(env.detail).toBe("minimal");
    expect(env.strings?.firstMessageBlock).not.toContain("acme-api");
  });
});
