import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listPlans,
  planToOffer,
  resolvePlan,
  syncPlanFile,
  withTaskStatuses,
  writePlanText,
} from "./planStore.js";

const PLAN = `# Add retry

Why and how.

## To-dos

- [ ] Add helper <!-- id: 1 -->
  check: npm test -- retry
- [ ] Use it <!-- id: 2 -->
`;

let cwd: string;
let dir: string;

function write(name: string, text: string, ageMs = 0) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plans-"));
  dir = path.join(cwd, ".continuous", "plans");
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe("listPlans", () => {
  it("derives status and counts, newest first", () => {
    write("approved.md", PLAN, 3000);
    write("draft.md", "# Draft\n", 2000);
    write("going.md", PLAN.replace("[ ] Add helper", "[x] Add helper"), 1000);
    write("done.md", PLAN.replaceAll("[ ]", "[x]"), 0);
    write("notes.txt", "ignored");
    const plans = listPlans(cwd);
    expect(plans.map((p) => [p.name, p.status, p.done, p.total])).toEqual([
      ["done", "done", 2, 2],
      ["going", "in-progress", 1, 2],
      ["draft", "draft", 0, 0],
      ["approved", "approved", 0, 2],
    ]);
    expect(plans[0].path).toBe(".continuous/plans/done.md");
    expect(plans[3].title).toBe("Add retry");
  });

  it("is empty without a plan directory", () => {
    expect(listPlans(path.join(cwd, "nowhere"))).toEqual([]);
  });
});

describe("resolvePlan", () => {
  it("finds a plan by name, file name and path", () => {
    const file = write("add-retry.md", PLAN);
    const real = fs.realpathSync(file);
    expect(resolvePlan("add-retry", cwd)).toEqual({ ok: true, file: real });
    expect(resolvePlan("add-retry.md", cwd)).toEqual({ ok: true, file: real });
    expect(resolvePlan(".continuous/plans/add-retry.md", cwd)).toEqual({
      ok: true,
      file: real,
    });
  });

  it("refuses traversal and paths outside the plan directory", () => {
    write("a.md", PLAN);
    fs.writeFileSync(path.join(cwd, "secret.md"), "# x");
    for (const bad of [
      "../secret",
      "..",
      "../../secret.md",
      ".continuous/plans/../../secret.md",
      path.join(cwd, "secret.md"),
      "a/../../secret.md",
      "a\0b",
      "",
    ]) {
      expect(resolvePlan(bad, cwd).ok, bad).toBe(false);
    }
  });

  it("refuses a link that leads out of the plan directory", () => {
    const outside = path.join(cwd, "outside.md");
    fs.writeFileSync(outside, "# out");
    try {
      fs.symlinkSync(outside, path.join(dir, "link.md"));
    } catch {
      return; // symlinks need privileges on Windows
    }
    expect(resolvePlan("link", cwd).ok).toBe(false);
  });

  it("reports a missing plan", () => {
    expect(resolvePlan("nope", cwd)).toMatchObject({ ok: false });
  });
});

describe("plan file writes", () => {
  it("changes only the checkbox marker of named items", () => {
    const plan = {
      updatedAt: "now",
      items: [
        { id: "1", text: "Add helper", status: "completed" as const },
        { id: "2", text: "Use it", status: "in_progress" as const },
      ],
    };
    expect(withTaskStatuses(PLAN, plan)).toBe(
      PLAN.replace("[ ] Add helper", "[x] Add helper").replace(
        "[ ] Use it",
        "[>] Use it",
      ),
    );
  });

  it("matches by text when the file has no id comments", () => {
    const text = "# T\n\n## To-dos\n\n- [ ] One\r\n- [ ] Two\r\n";
    const out = withTaskStatuses(text, {
      updatedAt: "now",
      items: [{ id: "9", text: "Two", status: "completed" }],
    });
    expect(out).toBe("# T\n\n## To-dos\n\n- [ ] One\r\n- [x] Two\r\n");
  });

  it("scrubs secrets on write", () => {
    const file = path.join(dir, "s.md");
    const token = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    writePlanText(file, `# S\n\nkey ${token}\n`);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(token);
  });

  it("syncPlanFile reports whether it wrote", () => {
    const file = write("p.md", PLAN);
    const plan = {
      updatedAt: "now",
      items: [{ id: "1", text: "Add helper", status: "completed" as const }],
    };
    expect(syncPlanFile(file, plan)).toBe(true);
    expect(syncPlanFile(file, plan)).toBe(false);
  });
});

describe("planToOffer", () => {
  it("offers the newest in-progress plan once per modification", () => {
    const file = write("going.md", PLAN.replace("[ ] Add", "[x] Add"));
    write("approved.md", PLAN, 5000);
    const first = planToOffer(undefined, cwd);
    expect(first?.name).toBe("going");
    expect(planToOffer({ [file]: first!.modifiedMs }, cwd)).toBeUndefined();
    expect(planToOffer({ [file]: 1 }, cwd)?.name).toBe("going");
  });
});
