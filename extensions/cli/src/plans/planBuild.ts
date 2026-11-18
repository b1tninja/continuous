import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

import type { TaskItem, TaskPlan } from "core/index.js";
import { parsePlanFile, planBuildMessage } from "core/util/planFile.js";
import { TASK_STATUS_MARKERS } from "core/util/taskPlan.js";

import { runCheckCommand, type CheckRun } from "../loop/loopChecks.js";
import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";
import { updateSessionPlanFile } from "../session.js";
import { checkToolPermissionApproval } from "../stream/streamChatResponse.helpers.js";
import { runTerminalCommandTool } from "../tools/runTerminalCommand.js";
import type { PreprocessedToolCall } from "../tools/types.js";
import { reloadPlanFile } from "../util/planFileReload.js";

import { syncPlanFile } from "./planStore.js";

/**
 * `continuous plan build`: the plain agent loop with a plan file as its task.
 * The plan's to-dos are the session's task list (seeded from the file, so a
 * resumed plan starts at its first unchecked to-do), each status the model
 * reports is written back to the file's checkboxes, and a to-do with a
 * `check:` is only done once the harness has run that command and it passed.
 */

let active: { file: string; cwd: string } | undefined;

export function activatePlanBuild(file: string, cwd = process.cwd()): void {
  active = { file, cwd };
}

export function activePlanBuild(): { file: string; cwd: string } | undefined {
  return active;
}

export function deactivatePlanBuild(): void {
  active = undefined;
}

/** Once the session exists: record the plan file and load its to-dos. */
export function seedPlanBuild(): void {
  if (!active) return;
  updateSessionPlanFile(pathToFileURL(active.file).href);
  reloadPlanFile(active.file);
}

/** The first to-do that is not completed or cancelled. */
export function firstUnchecked(
  items: readonly TaskItem[],
): TaskItem | undefined {
  return items.find(
    (i) => i.status !== "completed" && i.status !== "cancelled",
  );
}

/** The task for the run: the plan file, its step list and where to start. */
export function planBuildPrompt(cwd: string, file: string): string {
  const doc = parsePlanFile(fs.readFileSync(file, "utf-8"));
  const rel = path.relative(cwd, file).split(path.sep).join("/");
  const steps = doc.items
    .map((item, i) => {
      const mark =
        TASK_STATUS_MARKERS[(item.status as TaskItem["status"]) ?? "pending"];
      const check = item.check ? ` (check: ${String(item.check)})` : "";
      return `${i + 1}. ${mark} ${String(item.text)}${check}`;
    })
    .join("\n");
  const next = doc.items.findIndex(
    (i) => i.status !== "completed" && i.status !== "cancelled",
  );
  const where =
    next < 0
      ? "Every step is already done; check the work and finish."
      : next === 0
        ? "Start at step 1."
        : `Steps 1 to ${next} are done: resume at step ${next + 1}.`;
  return `${planBuildMessage(rel)}\n\nPlan: ${doc.title}\n${steps}\n\n${where} A step with a check: is verified by the harness, which runs that command after you mark the step completed; if it fails the step stays in progress and you are given its output, so fix the work and mark it completed again.`;
}

/** Writes the model's statuses into the plan file (best effort). */
export function syncActivePlan(plan: TaskPlan): void {
  if (!active) return;
  try {
    syncPlanFile(active.file, plan);
  } catch {
    // the task list stays the session's truth; the file is retried next update
  }
}

export interface CheckVerdict {
  status: "passed" | "failed" | "refused";
  output: string;
}

/**
 * Runs a to-do's check as the harness: the same permission decision as a Bash
 * call, and the same runner a Loop's check uses. A check that is refused (a
 * rule, or a prompt nobody can answer) did not run, so the to-do is not done.
 */
export async function runPlanCheck(
  command: string,
  run: (command: string) => Promise<CheckRun> = runCheckCommand,
): Promise<CheckVerdict> {
  const call = {
    id: "plan-check",
    name: runTerminalCommandTool.name,
    arguments: { command },
    argumentsStr: JSON.stringify({ command }),
    startNotified: true,
    tool: runTerminalCommandTool,
  } as PreprocessedToolCall;
  try {
    const permissions = await serviceContainer.get<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );
    const decision = await checkToolPermissionApproval(
      permissions.permissions,
      call,
      undefined,
      services.toolPermissions.isHeadless(),
    );
    if (!decision.approved) {
      return {
        status: "refused",
        output: decision.denialMessage ?? "A rule refused the command.",
      };
    }
    const result = await run(command);
    return {
      status: result.exitCode === 0 ? "passed" : "failed",
      output: result.output,
    };
  } catch (error) {
    return {
      status: "failed",
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

const OUTPUT_TAIL = 800;

/**
 * The plan the model asked for, with every to-do that newly claims to be
 * completed held to its `check:`. One that fails goes back to in progress (to
 * pending when another item already is, as one at a time is the rule) and the
 * notes tell the model why.
 */
export async function gateCompletions(
  previous: TaskPlan | undefined,
  next: TaskPlan,
  run: typeof runPlanCheck = runPlanCheck,
): Promise<{ plan: TaskPlan; notes: string[] }> {
  const notes: string[] = [];
  const before = new Map(previous?.items.map((i) => [i.id, i.status]));
  const items: TaskItem[] = [];
  const held: number[] = [];
  for (const item of next.items) {
    if (
      item.status === "completed" &&
      item.check &&
      before.get(item.id) !== "completed"
    ) {
      const verdict = await run(item.check);
      if (verdict.status !== "passed") {
        const output = verdict.output.trim().slice(-OUTPUT_TAIL);
        notes.push(
          `Check for "${item.text}" ${verdict.status === "refused" ? "was refused" : "failed"} (${item.check}), so it is not done.${
            output ? `\n${output}` : ""
          }`,
        );
        held.push(items.length);
        items.push({ ...item, status: "pending" });
        continue;
      }
    }
    items.push(item);
  }
  // One item runs at a time: the first held item goes back to in progress
  // unless another one already is
  if (held.length && !items.some((i) => i.status === "in_progress")) {
    items[held[0]] = { ...items[held[0]], status: "in_progress" };
  }
  return { plan: { ...next, items }, notes };
}
