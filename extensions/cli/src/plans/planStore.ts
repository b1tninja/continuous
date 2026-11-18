import fs from "fs";
import path from "path";

import type { TaskPlan } from "core/index.js";
import { writeFileAtomicSync } from "core/util/atomicWrite.js";
import {
  parsePlanFile,
  PLANS_DIR,
  type PlanDocument,
} from "core/util/planFile.js";
import { scrubForDisk } from "core/util/secretScan/scrubForDisk.js";
import { TASK_STATUS_MARKERS } from "core/util/taskPlan.js";

/**
 * The plan files in the workspace's plan directory (`.continuous/plans`,
 * plans/task-planning.md): listing them, finding one by name, and keeping the
 * file's checkboxes in step with the task list while a plan is built. Every
 * path this module touches is inside that directory.
 */

export type PlanStatus = "draft" | "approved" | "in-progress" | "done";

export interface PlanSummary {
  /** File name without `.md`: what `plan build <name>` takes */
  name: string;
  title: string;
  status: PlanStatus;
  done: number;
  total: number;
  modifiedMs: number;
  /** Workspace-relative path with forward slashes */
  path: string;
  /** Absolute path */
  file: string;
}

export function plansDir(cwd = process.cwd()): string {
  return path.join(cwd, ...PLANS_DIR.split("/"));
}

/**
 * done: every to-do completed or cancelled. in-progress: some started.
 * Nothing started: draft when the plan has no to-dos or a decision still
 * waits for an answer, otherwise approved (ready to build).
 */
export function planStatusOf(doc: PlanDocument): PlanStatus {
  const items = doc.items;
  const statuses = items.map((i) => i.status ?? "pending");
  if (
    items.length > 0 &&
    statuses.every((s) => s === "completed" || s === "cancelled")
  ) {
    return "done";
  }
  if (statuses.some((s) => s !== "pending")) {
    return "in-progress";
  }
  const open = doc.decisions.some((d) => !d.answer?.trim());
  return items.length === 0 || open ? "draft" : "approved";
}

export function summarizePlan(
  cwd: string,
  file: string,
  markdown: string,
  modifiedMs: number,
): PlanSummary {
  const doc = parsePlanFile(markdown);
  const name = path.basename(file).replace(/\.md$/i, "");
  return {
    name,
    title: doc.title || name,
    status: planStatusOf(doc),
    done: doc.items.filter((i) => i.status === "completed").length,
    total: doc.items.length,
    modifiedMs,
    path: path.relative(cwd, file).split(path.sep).join("/"),
    file,
  };
}

/** The workspace's plans, most recently modified first. */
export function listPlans(cwd = process.cwd()): PlanSummary[] {
  const dir = plansDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n));
  } catch {
    return [];
  }
  const out: PlanSummary[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      out.push(
        summarizePlan(cwd, file, fs.readFileSync(file, "utf-8"), stat.mtimeMs),
      );
    } catch {
      // unreadable: not listed
    }
  }
  return out.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A plan by name (`add-retry`, `add-retry.md`) or by path. Whatever the person
 * or a script passes, the answer is a regular file whose real path is inside
 * the workspace's plan directory: no `..`, no absolute path elsewhere, no
 * link out.
 */
export function resolvePlan(
  input: string,
  cwd = process.cwd(),
): { ok: true; file: string } | { ok: false; error: string } {
  const text = input.trim();
  if (!text || text.includes("\0")) {
    return { ok: false, error: "Give a plan name or path." };
  }
  const dir = plansDir(cwd);
  const isName = !/[\/]/.test(text);
  let candidate: string;
  if (isName) {
    const base = text.replace(/\.md$/i, "");
    if (!PLAN_NAME.test(base) || base.includes("..")) {
      return { ok: false, error: `"${text}" is not a plan name.` };
    }
    candidate = path.join(dir, `${base}.md`);
  } else {
    candidate = path.resolve(cwd, text);
    if (!inside(path.resolve(dir), candidate)) {
      return {
        ok: false,
        error: `Plans live in ${PLANS_DIR}: ${text} is not.`,
      };
    }
  }
  try {
    const realDir = fs.realpathSync(dir);
    const real = fs.realpathSync(candidate);
    if (!inside(realDir, real) || !fs.statSync(real).isFile()) {
      return {
        ok: false,
        error: `Plans live in ${PLANS_DIR}: ${text} is not.`,
      };
    }
    return { ok: true, file: real };
  } catch {
    return { ok: false, error: `No plan "${text}" in ${PLANS_DIR}.` };
  }
}

/** Plan files never hold a secret: the at-rest scrubber runs on every write. */
export function writePlanText(file: string, text: string): void {
  writeFileAtomicSync(file, scrubForDisk(text));
}

const CHECKBOX = /^(\s*(?:[-*+]|\d+\.)\s*)\[([ xX>!-])\](.*)$/;
const ID_COMMENT = /\s*<!--\s*id:\s*([A-Za-z0-9_.-]{1,40})\s*-->\s*$/;

/**
 * `markdown` with each to-do's checkbox set to its status in `plan`. Only the
 * marker character of a line that names an item (by id comment, else by its
 * text) changes: every other byte of the file stays.
 */
export function withTaskStatuses(markdown: string, plan: TaskPlan): string {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const byText = new Map(plan.items.map((i) => [i.text, i]));
  return markdown
    .split(/(\r?\n)/)
    .map((line) => {
      const m = CHECKBOX.exec(line);
      if (!m) return line;
      const idc = ID_COMMENT.exec(m[3]);
      const item = idc ? byId.get(idc[1]) : byText.get(m[3].trim());
      if (!item) return line;
      return `${m[1]}[${TASK_STATUS_MARKERS[item.status][1]}]${m[3]}`;
    })
    .join("");
}

/** Writes the plan's statuses into the file; false when nothing changed. */
export function syncPlanFile(file: string, plan: TaskPlan): boolean {
  const before = fs.readFileSync(file, "utf-8");
  const after = withTaskStatuses(before, plan);
  if (after === before) return false;
  writePlanText(file, after);
  return true;
}

/**
 * The in-progress plan an interactive start offers to resume: the most
 * recently modified one that was not offered at its current modified time.
 * `offered` is the record of earlier offers (path to modified time).
 */
export function planToOffer(
  offered: Record<string, number> | undefined,
  cwd = process.cwd(),
): PlanSummary | undefined {
  return listPlans(cwd).find(
    (p) => p.status === "in-progress" && offered?.[p.file] !== p.modifiedMs,
  );
}
