import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { IDE } from "..";
import { resolveRelativePathInDir } from "./ideUtils";
import { tryLink } from "../tools/permissions/testLinks";
import { resolveInputPath } from "./pathResolver";

const roots: string[] = [];

function ideFor(root: string): IDE {
  const rootUri = pathToFileURL(root).href;
  return {
    getWorkspaceDirs: async () => [rootUri],
    fileExists: async (uri: string) => {
      try {
        return fs.existsSync(fileURLToPath(uri));
      } catch {
        return false;
      }
    },
  } as IDE;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveInputPath workspace boundary", () => {
  it("treats a relative path that climbs out as outside the workspace", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cn-path-"));
    roots.push(parent);
    const workspace = path.join(parent, "proj");
    const outside = path.join(parent, "secret.txt");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "inside.txt"), "in");
    fs.writeFileSync(outside, "out");
    const ide = ideFor(workspace);

    const inside = await resolveInputPath(ide, "inside.txt");
    expect(inside?.isWithinWorkspace).toBe(true);
    expect(inside?.uri).toBe(
      pathToFileURL(path.join(workspace, "inside.txt")).href,
    );

    const climbed = await resolveInputPath(ide, "../secret.txt");
    expect(climbed?.isWithinWorkspace).toBe(false);
    expect(fileURLToPath(climbed!.uri)).toBe(outside);

    const nested = await resolveInputPath(ide, "sub/../../secret.txt");
    expect(nested?.isWithinWorkspace).toBe(false);
    expect(fileURLToPath(nested!.uri)).toBe(outside);

    expect(
      await resolveRelativePathInDir("../secret.txt", ide),
    ).toBeUndefined();
    expect(await resolveRelativePathInDir("inside.txt", ide)).toBe(
      pathToFileURL(path.join(workspace, "inside.txt")).href,
    );
    expect(await resolveInputPath(ide, "missing.txt")).toBeNull();

    const wsUri = pathToFileURL(workspace).href.replace(/\/$/, "");
    const byUri = await resolveInputPath(ide, `${wsUri}/../secret.txt`);
    expect(byUri?.isWithinWorkspace).toBe(false);
    expect(fileURLToPath(byUri!.uri)).toBe(outside);
    const encoded = await resolveInputPath(ide, `${wsUri}/%2E%2E/secret.txt`);
    expect(encoded?.isWithinWorkspace).toBe(false);
    expect(fileURLToPath(encoded!.uri)).toBe(outside);
    const stayed = await resolveInputPath(ide, `${wsUri}/sub/../inside.txt`);
    expect(stayed?.isWithinWorkspace).toBe(true);
    expect(fileURLToPath(stayed!.uri)).toBe(path.join(workspace, "inside.txt"));
  });

  it("follows a symlink to the file it names", async (ctx) => {
    const parent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cn-link-")),
    );
    roots.push(parent);
    const workspace = path.join(parent, "proj");
    const outside = path.join(parent, "secret.txt");
    const inside = path.join(workspace, "inside.txt");
    fs.mkdirSync(workspace);
    fs.writeFileSync(inside, "in");
    fs.writeFileSync(outside, "out");
    // File links need Developer Mode on Windows: skip there, with the reason
    const links = [
      tryLink(outside, path.join(workspace, "notes"), "file"),
      tryLink(inside, path.join(workspace, "alias"), "file"),
      tryLink(parent, path.join(workspace, "outdir")),
    ];
    const failed = links.find((l) => !l.ok);
    if (failed) return ctx.skip(failed.reason);
    const ide = ideFor(workspace);

    const escaped = await resolveInputPath(ide, "notes");
    expect(escaped?.isWithinWorkspace).toBe(false);
    expect(fileURLToPath(escaped!.uri)).toBe(outside);

    const stayed = await resolveInputPath(ide, "alias");
    expect(stayed?.isWithinWorkspace).toBe(true);
    expect(fileURLToPath(stayed!.uri)).toBe(inside);

    const created = await resolveInputPath(ide, "outdir/new.txt");
    expect(created?.isWithinWorkspace).toBe(false);
    expect(fileURLToPath(created!.uri)).toBe(path.join(parent, "new.txt"));
  });
});
