import fs from "fs";
import os from "os";
import path from "path";

import type { TaskPlan } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gateCompletions, planBuildPrompt } from "./planBuild.js";

const plan = (...items: [string, TaskPlan["items"][0]["status"], string?][]) =>
  ({
    updatedAt: "now",
    items: items.map(([id, status, check]) => ({
      id,
      text: `step ${id}`,
      status,
      ...(check && { check }),
    })),
  }) as TaskPlan;

describe("gateCompletions", () => {
  it("lets an item without a check complete and runs none", async () => {
    const run = vi.fn();
    const out = await gateCompletions(
      plan(["1", "in_progress"]),
      plan(["1", "completed"]),
      run,
    );
    expect(run).not.toHaveBeenCalled();
    expect(out.plan.items[0].status).toBe("completed");
    expect(out.notes).toEqual([]);
  });

  it("keeps a completed item whose check passes", async () => {
    const run = vi.fn().mockResolvedValue({ status: "passed", output: "" });
    const out = await gateCompletions(
      plan(["1", "in_progress", "npm test"]),
      plan(["1", "completed", "npm test"]),
      run,
    );
    expect(run).toHaveBeenCalledWith("npm test");
    expect(out.plan.items[0].status).toBe("completed");
  });

  it("sends a failed item back to in progress with the output", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ status: "failed", output: "1 test failed" });
    const out = await gateCompletions(
      plan(["1", "in_progress", "npm test"], ["2", "pending"]),
      plan(["1", "completed", "npm test"], ["2", "pending"]),
      run,
    );
    expect(out.plan.items.map((i) => i.status)).toEqual([
      "in_progress",
      "pending",
    ]);
    expect(out.notes[0]).toContain("failed");
    expect(out.notes[0]).toContain("1 test failed");
  });

  it("keeps one in progress when another item already is", async () => {
    const run = vi.fn().mockResolvedValue({ status: "refused", output: "no" });
    const out = await gateCompletions(
      plan(["1", "in_progress", "x"], ["2", "pending"]),
      plan(["1", "completed", "x"], ["2", "in_progress"]),
      run,
    );
    expect(out.plan.items.map((i) => i.status)).toEqual([
      "pending",
      "in_progress",
    ]);
    expect(out.notes[0]).toContain("refused");
  });

  it("does not re-run the check of an item that was already completed", async () => {
    const run = vi.fn();
    await gateCompletions(
      plan(["1", "completed", "x"]),
      plan(["1", "completed", "x"]),
      run,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("planBuildPrompt", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "planbuild-"));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("lists the steps and resumes at the first unchecked one", () => {
    const file = path.join(cwd, "p.md");
    fs.writeFileSync(
      file,
      "# Plan\n\n## To-dos\n\n- [x] One <!-- id: 1 -->\n- [x] Two <!-- id: 2 -->\n- [ ] Three <!-- id: 3 -->\n  check: npm test\n",
    );
    const prompt = planBuildPrompt(cwd, file);
    expect(prompt).toContain("Steps 1 to 2 are done: resume at step 3.");
    expect(prompt).toContain("3. [ ] Three (check: npm test)");
    expect(prompt).toContain("Build the plan in p.md");
  });
});
