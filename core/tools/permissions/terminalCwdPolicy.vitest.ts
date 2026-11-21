import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { protectedCommandHit } from "./protectedCall";
import { effectiveCwdForPolicy } from "../implementations/terminalCwd";

/**
 * A terminal command with `cwd` is judged from that folder. A relative path
 * in the command means a different file when the folder differs, so the
 * policy must read the folder the command really runs in.
 */
const path = nodePath.posix;
const HOME = "/home/me";
const ROOT = "/work/app";

const facts = {
  defaultCwd: ROOT,
  workspaceRoots: [ROOT],
  realpath: (p: string) => path.normalize(p),
  isDirectory: () => true,
  path,
};

describe("a command with cwd is judged from that folder", () => {
  it("a relative secret file is the same file whichever folder it is read from", () => {
    // `.env` is a secret wherever it sits; the folder only changes which one
    const here = protectedCommandHit("cat .env", HOME, [], ROOT, "bash");
    const there = protectedCommandHit(
      "cat .env",
      HOME,
      [],
      effectiveCwdForPolicy("pkg", facts),
      "bash",
    );
    expect(here?.kind).toBe("secret");
    expect(there?.kind).toBe("secret");
  });

  it("a bare file name is the file in the folder the command runs in", () => {
    // Workspace = the home folder, cwd ".ssh": `cat config` is the person's own
    // SSH config from there, and a harmless ~/config from the home folder
    const f = { ...facts, defaultCwd: HOME, workspaceRoots: [HOME] };
    const cwd = effectiveCwdForPolicy(".ssh", f);
    expect(cwd).toBe("/home/me/.ssh");
    expect(protectedCommandHit("cat config", HOME, [], cwd, "bash")?.kind).toBe(
      "secret",
    );
    expect(
      protectedCommandHit("cat config", HOME, [], HOME, "bash")?.kind,
    ).not.toBe("secret");
  });

  it("an invalid cwd is judged from the default folder, never from where it points", () => {
    expect(effectiveCwdForPolicy("../../etc", facts)).toBe(ROOT);
    expect(effectiveCwdForPolicy("/etc", facts)).toBe(ROOT);
  });
});
