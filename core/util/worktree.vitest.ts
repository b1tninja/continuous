import { execFile, execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyPatch,
  createItemWorktree,
  dirtyFiles,
  gitArgsFor,
  listLoopWorktrees,
  loopBranchName,
  patchFiles,
  removeStaleItemWorktree,
  removeWorktree,
  setupCommands,
  worktreePatch,
  type GitRunner,
  type WorktreeInfo,
} from "./worktree.js";
import {
  readScopeFilesFromDisk,
  decideFromFiles,
  setProjectConfigTrustedForRun,
  trustProjectScopes,
} from "../config/projectTrust.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The CLI's shape of the runner: execFile, stdout back, stderr as the error. */
const git: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });

let deps: { git: GitRunner; globalDir?: string } = { git };

async function samePath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  return path.resolve(ra).toLowerCase() === path.resolve(rb).toLowerCase();
}

/** A repository with a commit, a dirty tracked file and an untracked file. */
async function makeRepo(base: string): Promise<string> {
  const repo = path.join(base, "project");
  await fs.mkdir(repo, { recursive: true });
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "Test"], repo);
  await git(["config", "commit.gpgsign", "false"], repo);
  await git(["config", "core.autocrlf", "false"], repo);
  await fs.writeFile(path.join(repo, "a.txt"), "a1\na2\na3\n");
  await fs.writeFile(path.join(repo, "b.txt"), "b1\nb2\nb3\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(repo, "logo.bin"), Buffer.from([0, 1, 2, 255]));
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", "initial"], repo);
  // Dirty state: a tracked edit (unstaged), an untracked file, an ignored file.
  await fs.writeFile(path.join(repo, "a.txt"), "a1\na2 edited\na3\n");
  await fs.mkdir(path.join(repo, "new"), { recursive: true });
  await fs.writeFile(path.join(repo, "new", "untracked.txt"), "fresh\n");
  await fs.writeFile(path.join(repo, "ignored.txt"), "noise\n");
  return repo;
}

describe.skipIf(!hasGit)("worktree helper against a real repository", () => {
  let base: string;
  let repo: string;
  let root: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "continued-worktree-"));
    repo = await makeRepo(base);
    root = path.join(base, "worktrees");
    deps = { git, globalDir: path.join(base, "global") };
  });

  afterEach(async () => {
    setProjectConfigTrustedForRun(false);
    await fs.rm(base, { recursive: true, force: true });
  });

  async function create(itemId = "t1"): Promise<WorktreeInfo> {
    return createItemWorktree({ repo, slug: "demo", itemId, root }, deps);
  }

  /** Approve the repository's worktree config as it is now. */
  function approve(): void {
    const files = readScopeFilesFromDisk(repo, "worktree");
    const { fingerprint } = decideFromFiles(repo, "worktree", files);
    trustProjectScopes(repo, { worktree: fingerprint }, deps.globalDir);
  }

  test("create copies the dirty state and makes a baseline commit", async () => {
    const wt = await create();

    expect(wt.branch).toBe("continued/loop-demo-t1");
    expect(wt.path).toBe(path.join(root, "project", "demo-t1"));
    expect(wt.baseline).toMatch(/^[0-9a-f]{40}$/);

    // The uncommitted edit and the untracked file are there, the ignored one is not.
    expect(await fs.readFile(path.join(wt.path, "a.txt"), "utf8")).toBe(
      "a1\na2 edited\na3\n",
    );
    expect(
      await fs.readFile(path.join(wt.path, "new", "untracked.txt"), "utf8"),
    ).toBe("fresh\n");
    await expect(
      fs.access(path.join(wt.path, "ignored.txt")),
    ).rejects.toThrow();

    // The baseline is one commit on top of the main checkout's HEAD, and the
    // worktree is clean after it.
    const mainHead = (await git(["rev-parse", "HEAD"], repo)).trim();
    const parent = (await git(["rev-parse", "HEAD^"], wt.path)).trim();
    expect(parent).toBe(mainHead);
    expect((await git(["status", "--porcelain"], wt.path)).trim()).toBe("");
    expect(await worktreePatch(wt, deps)).toBe("");

    // The main checkout is left exactly as it was.
    expect(
      (await git(["status", "--porcelain"], repo)).split("\n").sort(),
    ).toEqual(["", " M a.txt", "?? new/"].sort());
  });

  test("a change in the worktree comes back as a patch that applies to the main checkout", async () => {
    const wt = await create();
    await fs.writeFile(path.join(wt.path, "b.txt"), "b1\nb2 by worker\nb3\n");
    await fs.writeFile(path.join(wt.path, "c.txt"), "created by worker\n");
    await fs.writeFile(
      path.join(wt.path, "logo.bin"),
      Buffer.from([9, 8, 7, 0, 255]),
    );

    const patch = await worktreePatch(wt, deps);
    expect(patch).toContain("diff --git a/b.txt b/b.txt");
    expect(patch).toContain("GIT binary patch");
    expect(patchFiles(patch).sort()).toEqual(["b.txt", "c.txt", "logo.bin"]);

    const result = await applyPatch(repo, patch, { touchedSince: [] }, deps);
    expect(result).toEqual({
      applied: true,
      files: expect.arrayContaining(["b.txt", "c.txt", "logo.bin"]),
    });
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe(
      "b1\nb2 by worker\nb3\n",
    );
    expect(await fs.readFile(path.join(repo, "c.txt"), "utf8")).toBe(
      "created by worker\n",
    );
    expect([...(await fs.readFile(path.join(repo, "logo.bin")))]).toEqual([
      9, 8, 7, 0, 255,
    ]);
    // The person's own dirty edit is still there, untouched.
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toBe(
      "a1\na2 edited\na3\n",
    );
  });

  test("an empty patch applies as nothing", async () => {
    expect(await applyPatch(repo, "", {}, deps)).toEqual({
      applied: true,
      files: [],
    });
  });

  test("a patch touching a file the person changed since is refused with the file named", async () => {
    const wt = await create();
    const before = await dirtyFiles(repo, deps);
    expect(before.sort()).toEqual(["a.txt", "new/untracked.txt"]);

    await fs.writeFile(path.join(wt.path, "b.txt"), "b1\nb2 by worker\nb3\n");
    const patch = await worktreePatch(wt, deps);

    // Meanwhile the person edits b.txt in the main checkout, compatibly or not.
    await fs.writeFile(path.join(repo, "b.txt"), "b1\nb2\nb3\nperson\n");
    const after = await dirtyFiles(repo, deps);
    const touchedSince = after.filter((f) => !before.includes(f));
    expect(touchedSince).toEqual(["b.txt"]);

    const result = await applyPatch(repo, patch, { touchedSince }, deps);
    expect(result).toEqual({
      applied: false,
      reason: "touched",
      files: ["b.txt"],
      message: expect.stringContaining("b.txt"),
    });
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe(
      "b1\nb2\nb3\nperson\n",
    );
  });

  test("a conflicting patch is refused and leaves the checkout alone", async () => {
    const wt = await create();
    await fs.writeFile(path.join(wt.path, "b.txt"), "b1\nb2 by worker\nb3\n");
    const patch = await worktreePatch(wt, deps);

    // The main checkout's b.txt moved on in a way the patch's context no longer matches.
    await fs.writeFile(path.join(repo, "b.txt"), "x1\nx2\nx3\n");
    await git(["commit", "-q", "-am", "diverge"], repo);

    const result = await applyPatch(repo, patch, {}, deps);
    expect(result).toMatchObject({
      applied: false,
      reason: "conflict",
      files: ["b.txt"],
    });
    expect(result.applied === false && result.message.length > 0).toBe(true);
    expect(await fs.readFile(path.join(repo, "b.txt"), "utf8")).toBe(
      "x1\nx2\nx3\n",
    );
  });

  test("remove deletes the worktree and the branch", async () => {
    const wt = await create();
    await fs.writeFile(path.join(wt.path, "scratch.txt"), "unsaved\n");

    await removeWorktree(repo, wt, { deleteBranch: true }, deps);

    await expect(fs.access(wt.path)).rejects.toThrow();
    const branches = await git(["branch", "--list", "continued/loop-*"], repo);
    expect(branches.trim()).toBe("");
    expect(await listLoopWorktrees(repo, deps)).toEqual([]);
  });

  test("remove can keep the branch", async () => {
    const wt = await create();
    await removeWorktree(repo, wt, { deleteBranch: false }, deps);
    const branches = await git(["branch", "--list", "continued/loop-*"], repo);
    expect(branches.trim()).toBe("continued/loop-demo-t1");
  });

  test("a worktree or a branch an interrupted wave left is removed, so the item can get a new one", async () => {
    // Nothing to remove in a clean repository
    expect(await removeStaleItemWorktree(repo, "demo", "t1", deps)).toBe(false);

    // A whole worktree left behind
    const left = await create("t1");
    expect(await removeStaleItemWorktree(repo, "demo", "t1", deps)).toBe(true);
    await expect(fs.access(left.path)).rejects.toThrow();
    const again = await create("t1");
    expect(again.branch).toBe("continued/loop-demo-t1");

    // The branch alone, its folder gone
    await removeWorktree(repo, again, { deleteBranch: false }, deps);
    expect(await removeStaleItemWorktree(repo, "demo", "t1", deps)).toBe(true);
    const branches = await git(["branch", "--list", "continued/loop-*"], repo);
    expect(branches.trim()).toBe("");
    expect((await create("t1")).branch).toBe("continued/loop-demo-t1");
  });

  test("listing finds only loop worktrees", async () => {
    const other = path.join(base, "other-worktree");
    await git(
      ["worktree", "add", "-q", "-b", "feature/x", other, "HEAD"],
      repo,
    );
    const wt1 = await create("t1");
    const wt2 = await create("t2");

    const found = await listLoopWorktrees(repo, deps);
    expect(found.map((w) => w.branch).sort()).toEqual([
      "continued/loop-demo-t1",
      "continued/loop-demo-t2",
    ]);
    const byBranch = Object.fromEntries(found.map((w) => [w.branch, w]));
    expect(await samePath(byBranch[wt1.branch].path, wt1.path)).toBe(true);
    expect(await samePath(byBranch[wt2.branch].path, wt2.path)).toBe(true);
    expect(byBranch[wt1.branch].head).toBe(wt1.baseline);
  });

  test("setup commands from .continue/worktrees.json run in the worktree with the root path", async () => {
    await fs.mkdir(path.join(repo, ".continue"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".continue", "worktrees.json"),
      JSON.stringify({
        "setup-worktree": [
          "node -e \"require('fs').writeFileSync('setup-ran.txt', process.env.ROOT_WORKTREE_PATH)\"",
          "node -e \"require('fs').appendFileSync('setup-ran.txt', ' ' + process.argv[1])\" \"$ROOT_WORKTREE_PATH\"",
        ],
      }),
    );
    approve();
    const ran: { command: string; cwd: string }[] = [];
    const recording = {
      ...deps,
      shell: async (command: string, cwd: string) => {
        ran.push({ command, cwd });
        return "";
      },
    };
    const wt = await createItemWorktree(
      { repo, slug: "demo", itemId: "t1", root },
      recording,
    );
    expect(ran).toHaveLength(2);
    expect(ran.every((r) => r.cwd === wt.path)).toBe(true);
    expect(ran[1].command).toContain(repo);
    expect(ran[1].command).not.toContain("$ROOT_WORKTREE_PATH");

    // The default shell runner really runs them, with the variable in the environment.
    const wt2 = await createItemWorktree(
      { repo, slug: "demo", itemId: "t2", root },
      deps,
    );
    expect(
      await fs.readFile(path.join(wt2.path, "setup-ran.txt"), "utf8"),
    ).toBe(`${repo} ${repo}`);
    // The .continue folder itself was untracked in the main checkout, so the
    // worktree has it too, but the setup output is a change on top of the baseline.
    expect(patchFiles(await worktreePatch(wt2, deps))).toEqual([
      "setup-ran.txt",
    ]);
  });

  const canaryConfig = (canary: string) =>
    JSON.stringify({
      "setup-worktree": [
        `node -e "require('fs').writeFileSync(process.argv[1], 'pwned')" "${canary.replace(/\\/g, "/")}"`,
      ],
    });

  async function writeRepoConfig(content: string): Promise<void> {
    await fs.mkdir(path.join(repo, ".continue"), { recursive: true });
    await fs.writeFile(path.join(repo, ".continue", "worktrees.json"), content);
  }

  test("an untrusted repository's setup commands do not run; the worktree is still made and a notice says why", async () => {
    const canary = path.join(base, "canary.txt");
    await writeRepoConfig(canaryConfig(canary));
    const notices: string[] = [];
    const wt = await createItemWorktree(
      { repo, slug: "demo", itemId: "t1", root },
      { ...deps, notify: (m) => notices.push(m) },
    );
    expect(await fs.stat(wt.path).then(() => true)).toBe(true);
    expect(
      await fs.stat(canary).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(".continue/worktrees.json");
    expect(notices[0]).toContain("continuous project trust");
    expect(wt.setupNotice).toBe(notices[0]);
  });

  test("an approved fingerprint runs the commands", async () => {
    const canary = path.join(base, "canary.txt");
    await writeRepoConfig(canaryConfig(canary));
    approve();
    const wt = await create();
    expect(wt.setupNotice).toBeUndefined();
    expect(await fs.readFile(canary, "utf8")).toBe("pwned");
  });

  test("a config changed after approval is not run until approved again", async () => {
    const canary = path.join(base, "canary.txt");
    await writeRepoConfig(canaryConfig(canary));
    approve();
    const evil = path.join(base, "canary2.txt");
    await writeRepoConfig(canaryConfig(evil));
    const wt = await create();
    expect(wt.setupNotice).toBeDefined();
    expect(
      await fs.stat(evil).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await fs.stat(canary).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    approve();
    await create("t2");
    expect(await fs.readFile(evil, "utf8")).toBe("pwned");
  });

  test("a headless run (no saved trust) refuses unless the run flag is set", async () => {
    const canary = path.join(base, "canary.txt");
    await writeRepoConfig(canaryConfig(canary));
    const refused = await create("t1");
    expect(refused.setupNotice).toBeDefined();
    expect(
      await fs.stat(canary).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    setProjectConfigTrustedForRun(true);
    await create("t2");
    expect(await fs.readFile(canary, "utf8")).toBe("pwned");
  });

  test("the user's own global worktrees.json runs without trust", async () => {
    const canary = path.join(base, "global-canary.txt");
    await fs.mkdir(path.join(base, "global"), { recursive: true });
    await fs.writeFile(
      path.join(base, "global", "worktrees.json"),
      canaryConfig(canary),
    );
    const wt = await create();
    expect(wt.setupNotice).toBeUndefined();
    expect(await fs.readFile(canary, "utf8")).toBe("pwned");
  });

  test("a global folder inside the repository is not the user's", async () => {
    const canary = path.join(base, "inside-canary.txt");
    const inside = path.join(repo, "fake-global");
    await fs.mkdir(inside, { recursive: true });
    await fs.writeFile(
      path.join(inside, "worktrees.json"),
      canaryConfig(canary),
    );
    await createItemWorktree(
      { repo, slug: "demo", itemId: "t1", root },
      { git, globalDir: inside },
    );
    expect(
      await fs.stat(canary).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("setup runs with the scrubbed environment", async () => {
    const out = path.join(base, "env.txt");
    process.env.N6_SECRET_TOKEN = "hunter2";
    try {
      await writeRepoConfig(
        JSON.stringify({
          "setup-worktree": [
            `node -e "require('fs').writeFileSync(process.argv[1], process.env.N6_SECRET_TOKEN || 'absent')" "${out.replace(/\\/g, "/")}"`,
          ],
        }),
      );
      approve();
      await create();
      expect(await fs.readFile(out, "utf8")).toBe("absent");
    } finally {
      delete process.env.N6_SECRET_TOKEN;
    }
  });

  test("a failing setup command removes the half-made worktree and rethrows", async () => {
    await fs.mkdir(path.join(repo, ".continue"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".continue", "worktrees.json"),
      JSON.stringify({ "setup-worktree": ['node -e "process.exit(3)"'] }),
    );
    approve();
    await expect(create()).rejects.toThrow();
    expect(await listLoopWorktrees(repo, deps)).toEqual([]);
    const branches = await git(["branch", "--list", "continued/loop-*"], repo);
    expect(branches.trim()).toBe("");
  });
});

describe("worktree helper, pure parts", () => {
  test("branch names are safe for git refs", () => {
    expect(loopBranchName("My Plan", "item 3")).toBe(
      "continued/loop-My-Plan-item-3",
    );
    expect(loopBranchName("a/b:c", "..x..")).toBe("continued/loop-a-b-c-x");
    expect(loopBranchName("", "")).toBe("continued/loop-item-item");
  });

  test("patchFiles reads both sides of a rename and quoted names", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      'diff --git "a/sp ace.txt" "b/sp ace.txt"',
      "index 000..111 100644",
    ].join("\n");
    expect(patchFiles(patch)).toEqual(["old.txt", "new.txt", "sp ace.txt"]);
  });

  test("setupCommands prefers the platform key and substitutes the root path", () => {
    const config = {
      "setup-worktree": ["npm ci"],
      "setup-worktree-windows": "copy $ROOT_WORKTREE_PATH\\.env .env",
      "setup-worktree-unix": ["cp ${ROOT_WORKTREE_PATH}/.env .env", ""],
    };
    expect(setupCommands(config, "/repo", "linux")).toEqual([
      "cp /repo/.env .env",
    ]);
    expect(setupCommands(config, "C:\\repo", "win32")).toEqual([
      "copy C:\\repo\\.env .env",
    ]);
    expect(
      setupCommands({ "setup-worktree": ["npm ci"] }, "/r", "darwin"),
    ).toEqual(["npm ci"]);
    expect(setupCommands({}, "/r", "linux")).toEqual([]);
  });
});

describe("gitArgsFor", () => {
  test("passes core.longpaths for the one command on Windows only", () => {
    expect(gitArgsFor(["worktree", "add"], "win32")).toEqual([
      "-c",
      "core.longpaths=true",
      "worktree",
      "add",
    ]);
    expect(gitArgsFor(["worktree", "add"], "linux")).toEqual([
      "worktree",
      "add",
    ]);
    expect(gitArgsFor(["status"], "darwin")).toEqual(["status"]);
  });
});
