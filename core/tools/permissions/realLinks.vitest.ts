import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deputyCallHit } from "./deputyCall";
import { localLinkResolver, resolveRealPath } from "./realPath";
import { isCaseInsensitive, needsLink, tryLink } from "./testLinks";

/**
 * The real-link probes on the real file system. They run on every platform:
 * the directory link is a symlink on Linux and macOS and a junction on
 * Windows. See testLinks.ts for which runner proves which case: pull requests
 * run the core tests on ubuntu-latest only, so the Windows and macOS rows are
 * proved on those machines, not by CI.
 */
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "links-")));
const ws = path.join(base, "ws");
const second = path.join(base, "second");
const outside = path.join(base, "outside");
for (const d of [ws, second, outside]) fs.mkdirSync(d);
fs.writeFileSync(path.join(outside, "secret.txt"), "x");
fs.writeFileSync(path.join(ws, "a.txt"), "x");
fs.writeFileSync(path.join(second, "b.txt"), "x");

const dirLink = tryLink(outside, path.join(ws, "out-dir"));
const fileLink = tryLink(
  path.join(outside, "secret.txt"),
  path.join(ws, "out-file"),
  "file",
);
const inLink = tryLink(second, path.join(ws, "to-second"));
const danglingLink = tryLink(
  path.join(base, "missing"),
  path.join(ws, "dangling"),
);
const aliasLink = tryLink(ws, path.join(base, "ws-alias"));
const caseInsensitive = isCaseInsensitive(ws);
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("real links, resolved by realPath.ts", () => {
  it.skipIf(!dirLink.ok)(
    needsLink("a directory link that leaves the workspace", dirLink),
    () => {
      const r = resolveRealPath("out-dir/secret.txt", ws);
      expect(r?.isWithinWorkspace).toBe(false);
      expect(resolveRealPath("out-dir/new.txt", ws)?.isWithinWorkspace).toBe(
        false,
      );
    },
  );

  it.skipIf(!fileLink.ok)(
    needsLink("a file link that leaves the workspace", fileLink),
    () => {
      expect(resolveRealPath("out-file", ws)?.isWithinWorkspace).toBe(false);
    },
  );

  it.skipIf(!dirLink.ok || !danglingLink.ok)(
    needsLink(
      "a dangling link is judged where it would land",
      dirLink.ok ? danglingLink : dirLink,
    ),
    () => {
      expect(resolveRealPath("dangling", ws)?.isWithinWorkspace).toBe(false);
    },
  );

  it.skipIf(!inLink.ok)(
    needsLink("a link into the second root is inside with two roots", inLink),
    () => {
      expect(resolveRealPath("to-second/b.txt", ws)?.isWithinWorkspace).toBe(
        false,
      );
      expect(
        resolveRealPath("to-second/b.txt", ws, os.homedir(), [second])
          ?.isWithinWorkspace,
      ).toBe(true);
    },
  );

  it.skipIf(!aliasLink.ok)(
    needsLink("a workspace named through a link alias", aliasLink),
    () => {
      const alias = path.join(base, "ws-alias");
      expect(resolveRealPath("a.txt", alias)?.isWithinWorkspace).toBe(true);
      expect(
        resolveRealPath(path.join(ws, "a.txt"), alias)?.isWithinWorkspace,
      ).toBe(true);
    },
  );

  it.skipIf(!caseInsensitive)(
    "a different case names the same file (case-insensitive file systems only: macOS, Windows)",
    () => {
      expect(resolveRealPath("A.TXT", ws)?.isWithinWorkspace).toBe(true);
    },
  );

  it("a plain path inside is inside, and one that climbs out is not", () => {
    expect(resolveRealPath("a.txt", ws)?.isWithinWorkspace).toBe(true);
    expect(
      resolveRealPath("../outside/secret.txt", ws)?.isWithinWorkspace,
    ).toBe(false);
  });
});

describe("an MCP path argument through a real link", () => {
  const ask = (filePath: string, dirs: string[]) =>
    deputyCallHit({
      toolName: "mcp__files__open",
      parsedArgs: { path: filePath },
      mcp: true,
      cwd: dirs[0],
      workspaceDirs: dirs,
      resolvePath: localLinkResolver(dirs),
    });

  it.skipIf(!dirLink.ok)(
    needsLink("asks when the link leaves the workspace", dirLink),
    () => {
      expect(ask("out-dir/secret.txt", [ws])?.kind).toBe("file-deputy");
    },
  );

  it.skipIf(!inLink.ok)(
    needsLink("stays quiet when the link lands in another root", inLink),
    () => {
      expect(ask("to-second/b.txt", [ws])?.kind).toBe("file-deputy");
      expect(ask("to-second/b.txt", [ws, second])).toBeUndefined();
    },
  );

  it("stays quiet for a plain file", () => {
    expect(ask("a.txt", [ws])).toBeUndefined();
  });
});
