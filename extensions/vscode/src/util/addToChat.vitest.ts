import { describe, expect, it, vi } from "vitest";

import {
  AddToChatHost,
  buildAddToChatPayload,
  isSecretPath,
  uriOfTabInput,
  urisFromCommandArgs,
} from "./addToChat";

function hostWith(
  dirs: string[],
  entries: Record<string, "file" | "folder">,
): AddToChatHost & { stat: ReturnType<typeof vi.fn> } {
  return {
    workspaceDirs: () => dirs,
    stat: vi.fn(async (uri: string) => entries[uri]),
  };
}

describe("buildAddToChatPayload", () => {
  it("turns Explorer files and folders into file and folder items", async () => {
    const host = hostWith(["file:///ws"], {
      "file:///ws/src/a.ts": "file",
      "file:///ws/src/lib": "folder",
    });
    const payload = await buildAddToChatPayload(
      ["file:///ws/src/a.ts", "file:///ws/src/lib"],
      host,
    );
    expect(payload).toEqual({
      data: [
        { type: "file", fullPath: "file:///ws/src/a.ts", name: "a.ts" },
        { type: "folder", fullPath: "file:///ws/src/lib", name: "lib" },
      ],
    });
  });

  it("keeps remote and virtual URIs as URIs, never file system paths", async () => {
    const remote = "vscode-remote://ssh-remote+box/home/me/proj/main.py";
    const vfs = "vscode-vfs://github/owner/repo/README.md";
    const host = hostWith(
      [
        "vscode-remote://ssh-remote+box/home/me/proj",
        "vscode-vfs://github/owner/repo",
      ],
      { [remote]: "file", [vfs]: "file" },
    );
    const payload = await buildAddToChatPayload([remote, vfs], host);
    expect(payload.data.map((d) => d.fullPath)).toEqual([remote, vfs]);
    expect(payload.refused).toBeUndefined();
  });

  it("finds each resource in its own folder of a multi-root workspace", async () => {
    const host = hostWith(["file:///api", "file:///web", "file:///web/pkg"], {
      "file:///api/main.go": "file",
      "file:///web/pkg/index.ts": "file",
      "file:///web/pkg/keys": "folder",
    });
    const payload = await buildAddToChatPayload(
      [
        "file:///api/main.go",
        "file:///web/pkg/index.ts",
        "file:///web/pkg/keys",
      ],
      host,
    );
    expect(payload.data.map((d) => d.name)).toEqual(["main.go", "index.ts"]);
    expect(payload.refused).toEqual([{ name: "keys", reason: "secret" }]);
  });

  it("adds a workspace folder itself as a folder", async () => {
    const host = hostWith(["file:///ws"], { "file:///ws": "folder" });
    const payload = await buildAddToChatPayload(["file:///ws"], host);
    expect(payload.data).toEqual([
      { type: "folder", fullPath: "file:///ws", name: "ws" },
    ]);
  });

  it.each([
    "file:///ws/.env",
    "file:///ws/app/.env.local",
    "file:///ws/certs/server.pem",
    "file:///ws/deploy/id_rsa",
    "file:///ws/.ssh/config",
    "file:///ws/.aws/credentials",
  ])("refuses %s as a secret and sends nothing about it", async (uri) => {
    const host = hostWith(["file:///ws"], { [uri]: "file" });
    const payload = await buildAddToChatPayload([uri], host);
    expect(payload.data).toEqual([]);
    expect(payload.refused?.[0].reason).toBe("secret");
  });

  it("refuses a secret folder", async () => {
    const host = hostWith(["file:///ws"], { "file:///ws/secrets": "folder" });
    const payload = await buildAddToChatPayload(["file:///ws/secrets"], host);
    expect(payload).toEqual({
      data: [],
      refused: [{ name: "secrets", reason: "secret" }],
    });
  });

  it("refuses files outside every workspace folder without asking the host", async () => {
    const host = hostWith(["file:///ws"], {});
    const payload = await buildAddToChatPayload(
      ["file:///elsewhere/notes.md", "file:///ws/../etc/passwd"],
      host,
    );
    expect(payload.refused).toEqual([
      { name: "notes.md", reason: "outside-workspace" },
      { name: "passwd", reason: "outside-workspace" },
    ]);
    expect(host.stat).not.toHaveBeenCalled();
  });

  it("refuses a URI whose scheme no workspace folder has", async () => {
    const host = hostWith(["file:///ws"], {});
    const payload = await buildAddToChatPayload(
      ["vscode-userdata:/User/settings.json"],
      host,
    );
    expect(payload.refused).toEqual([
      { name: "settings.json", reason: "outside-workspace" },
    ]);
  });

  it("refuses unsaved editors", async () => {
    const host = hostWith(["file:///ws"], {});
    const payload = await buildAddToChatPayload(["untitled:Untitled-1"], host);
    expect(payload.refused).toEqual([
      { name: "Untitled-1", reason: "unsaved" },
    ]);
    expect(host.stat).not.toHaveBeenCalled();
  });

  it("refuses what the host cannot find", async () => {
    const host = hostWith(["file:///ws"], {});
    const payload = await buildAddToChatPayload(["file:///ws/gone.ts"], host);
    expect(payload.refused).toEqual([{ name: "gone.ts", reason: "not-found" }]);
  });

  it("sends each URI once", async () => {
    const host = hostWith(["file:///ws"], { "file:///ws/a.ts": "file" });
    const payload = await buildAddToChatPayload(
      ["file:///ws/a.ts", "file:///ws/a.ts"],
      host,
    );
    expect(payload.data).toHaveLength(1);
    expect(host.stat).toHaveBeenCalledTimes(1);
  });
});

describe("isSecretPath", () => {
  it("applies folder patterns to folders only", () => {
    expect(isSecretPath("keys", "folder")).toBe(true);
    expect(isSecretPath("keys", "file")).toBe(false);
    expect(isSecretPath("src/keys/a.ts", "file")).toBe(true);
  });

  it("leaves ordinary source alone", () => {
    expect(isSecretPath("src/index.ts", "file")).toBe(false);
    expect(isSecretPath("src", "folder")).toBe(false);
    expect(isSecretPath("", "folder")).toBe(false);
  });
});

describe("urisFromCommandArgs", () => {
  const a = { path: "a" };
  const b = { path: "b" };
  const active = { path: "active" };

  it("uses the Explorer's multi-selection", () => {
    expect(urisFromCommandArgs(a, [a, b], active)).toEqual([a, b]);
  });

  it("uses the clicked resource when the second argument is not a list", () => {
    // editor/title/context passes (uri, { groupId, editorIndex })
    expect(urisFromCommandArgs(a, { groupId: 1 }, active)).toEqual([a]);
    expect(urisFromCommandArgs(a, [], active)).toEqual([a]);
  });

  it("falls back to the active editor from the palette", () => {
    expect(urisFromCommandArgs(undefined, undefined, active)).toEqual([active]);
    expect(urisFromCommandArgs(undefined, undefined, undefined)).toEqual([]);
  });
});

describe("uriOfTabInput", () => {
  it("reads text, notebook and custom editors, and the modified side of a diff", () => {
    expect(uriOfTabInput({ uri: "u" })).toBe("u");
    expect(uriOfTabInput({ original: "o", modified: "m" })).toBe("m");
  });

  it("ignores tabs without a resource", () => {
    expect(uriOfTabInput({ viewType: "webview" })).toBeUndefined();
    expect(uriOfTabInput(undefined)).toBeUndefined();
  });
});
