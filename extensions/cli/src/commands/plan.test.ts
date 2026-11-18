import fs from "fs";
import os from "os";
import path from "path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addRunLimitOptions } from "../budget/runLimits.js";
import { addCommonOptions } from "../shared-options.js";

import { chat } from "./chat.js";
import {
  planListCommand,
  preparePlanBuild,
  registerPlanCommand,
} from "./plan.js";

vi.mock("./chat.js", () => ({ chat: vi.fn(async () => {}) }));
const exitCodes: number[] = [];
vi.mock("../util/exit.js", () => ({
  gracefulExit: vi.fn(async (code: number) => {
    exitCodes.push(code);
  }),
}));

let cwd: string;
let dir: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plancmd-"));
  dir = path.join(cwd, ".continuous", "plans");
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const io = () => {
  const lines: string[] = [];
  return {
    lines,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(l),
  };
};

describe("plan list", () => {
  it("prints rows and json", () => {
    fs.writeFileSync(
      path.join(dir, "a.md"),
      "# A\n\n## To-dos\n\n- [x] one <!-- id: 1 -->\n- [ ] two <!-- id: 2 -->\n",
    );
    const text = io();
    expect(planListCommand({}, cwd, text)).toBe(0);
    expect(text.lines[1]).toMatch(
      /^in-progress\s+1\/2\s+\S+ \S+\s+\.continuous\/plans\/a\.md\s+A$/,
    );
    const json = io();
    planListCommand({ json: true }, cwd, json);
    const [row] = JSON.parse(json.lines[0]);
    expect(row).toMatchObject({
      name: "a",
      status: "in-progress",
      done: 1,
      total: 2,
    });
    expect(row.file).toBeUndefined();
  });

  it("says so when there are no plans", () => {
    const text = io();
    planListCommand({}, path.join(cwd, "x"), text);
    expect(text.lines[0]).toContain("No plans");
  });
});

describe("plan build preparation", () => {
  it("refuses traversal, drafts and done plans", () => {
    fs.writeFileSync(path.join(dir, "d.md"), "# D\n");
    fs.writeFileSync(path.join(dir, "ok.md"), "# O\n\n## To-dos\n\n- [x] a\n");
    expect(preparePlanBuild("../d", {}, cwd).ok).toBe(false);
    expect(preparePlanBuild("d", {}, cwd)).toMatchObject({ ok: false });
    expect(preparePlanBuild("ok", {}, cwd)).toMatchObject({
      ok: false,
      error: expect.stringContaining("done"),
    });
    expect(preparePlanBuild("d", { force: true }, cwd).ok).toBe(true);
  });

  it("builds an approved plan", () => {
    fs.writeFileSync(path.join(dir, "a.md"), "# A\n\n## To-dos\n\n- [ ] one\n");
    const r = preparePlanBuild("a", {}, cwd);
    expect(r.ok && r.prompt).toContain("Start at step 1.");
  });
});

describe("plan build through the real command line", () => {
  // The root declares the same flags as `plan build`, so commander gives them
  // to the root wherever they stand on the line.
  const program = () => {
    const root = new Command().exitOverride();
    addRunLimitOptions(addCommonOptions(root))
      .argument("[prompt]")
      .option("-p, --print")
      .action(() => {});
    registerPlanCommand(root);
    return root;
  };
  const approved = () =>
    fs.writeFileSync(path.join(dir, "a.md"), "# A\n\n## To-dos\n\n- [ ] one\n");
  const chatOptions = () => vi.mocked(chat).mock.calls[0][1] as any;

  beforeEach(() => {
    vi.mocked(chat).mockClear();
    exitCodes.length = 0;
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [
      "after the subcommand",
      ["plan", "build", "a", "-p", "--config", "c.yaml"],
    ],
    [
      "before the subcommand",
      ["--config", "c.yaml", "plan", "build", "a", "-p"],
    ],
    [
      "between the subcommands",
      ["plan", "--config", "c.yaml", "build", "a", "-p"],
    ],
  ])("forwards --config given %s", async (_where, args) => {
    approved();
    await program().parseAsync(["node", "continuous", ...args]);
    expect(chatOptions().config).toBe("c.yaml");
    expect(chatOptions().headless).toBe(true);
    expect(exitCodes).toEqual([0]);
  });

  it("forwards the permission, mode and limit flags", async () => {
    approved();
    await program().parseAsync([
      "node",
      "continuous",
      "plan",
      "build",
      "a",
      "-p",
      "--auto",
      "--allow",
      "Bash",
      "--allow",
      "Read",
      "--exclude",
      "Write",
      "--max-turns",
      "3",
      "--rule",
      "be brief",
    ]);
    expect(chatOptions()).toMatchObject({
      auto: true,
      allow: ["Bash", "Read"],
      exclude: ["Write"],
      maxTurns: "3",
      rule: ["be brief"],
    });
    expect(chatOptions().print).toBeUndefined();
  });

  it("refuses a done plan and a draft on stderr with exit 2", async () => {
    fs.writeFileSync(path.join(dir, "c.md"), "# C\n\n## To-dos\n\n- [x] a\n");
    fs.writeFileSync(path.join(dir, "b.md"), "# B\n");
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      written.push(String(c));
      return true;
    }) as any);
    await program().parseAsync([
      "node",
      "continuous",
      "plan",
      "build",
      "c",
      "-p",
    ]);
    await program().parseAsync([
      "node",
      "continuous",
      "plan",
      "build",
      "b",
      "-p",
    ]);
    expect(exitCodes).toEqual([2, 2]);
    expect(written[0]).toMatch(/done/);
    expect(written[1]).toMatch(/draft/);
    expect(chat).not.toHaveBeenCalled();
  });
});
