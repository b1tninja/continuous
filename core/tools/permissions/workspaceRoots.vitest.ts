import { describe, expect, it } from "vitest";
import { deputyWorkspace } from "./workspaceRoots";

describe("deputyWorkspace", () => {
  it("turns file URIs into paths and offers a link resolver", () => {
    const w = deputyWorkspace(["file:///home/dev/a", "file:///home/dev/b"]);
    expect(w.workspaceDirs).toHaveLength(2);
    expect(w.workspaceDirs?.[0]).toMatch(/home[\\/]dev[\\/]a$/);
    expect(w.resolvePath).toBeTypeOf("function");
  });

  it("takes a bare path, as the CLI gives it", () => {
    expect(deputyWorkspace(["/work/x"]).workspaceDirs).toEqual(["/work/x"]);
  });

  it("offers no link resolver for a remote or virtual workspace", () => {
    const w = deputyWorkspace(["vscode-remote://ssh/host/home/a"]);
    expect(w.workspaceDirs).toEqual([]);
    expect(w.resolvePath).toBeUndefined();
  });

  it("offers none for a mix, where a root cannot be followed", () => {
    expect(
      deputyWorkspace(["file:///a", "vscode-remote://x/b"]).resolvePath,
    ).toBeUndefined();
  });

  it("has nothing for no folders", () => {
    expect(deputyWorkspace([])).toEqual({ workspaceDirs: [] });
  });
});
