import type { Command } from "commander";

import { addRunLimitOptions } from "../budget/runLimits.js";
import {
  configureConsoleForHeadless,
  safeStderr,
  safeStdout,
} from "../init.js";
import {
  activatePlanBuild,
  deactivatePlanBuild,
  planBuildPrompt,
} from "../plans/planBuild.js";
import {
  listPlans,
  planStatusOf,
  resolvePlan,
  type PlanSummary,
} from "../plans/planStore.js";
import { addCommonOptions } from "../shared-options.js";
import { gracefulExit } from "../util/exit.js";
import { logger } from "../util/logger.js";

import { chat, type ChatOptions } from "./chat.js";

/**
 * `continuous plan list` and `continuous plan build <name|path>`: the plan
 * files Plan mode writes to `.continuous/plans` (plans/task-planning.md).
 */

export interface PlanIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

// With -p in argv init.ts replaces process.stdout/stderr.write with no-ops so
// that dependencies stay quiet; the command's own output has to go through
// the saved originals or a refusal under -p prints nothing.
const stdio: PlanIo = {
  out: (l) => safeStdout(`${l}\n`),
  err: (l) => safeStderr(`${l}\n`),
};

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

export function formatPlanRows(plans: PlanSummary[]): string[] {
  return plans.map(
    (p) =>
      `${p.status.padEnd(11)} ${`${p.done}/${p.total}`.padEnd(6)} ${formatTime(p.modifiedMs)}  ${p.path}  ${p.title}`,
  );
}

export function planListCommand(
  options: { json?: boolean },
  cwd = process.cwd(),
  io: PlanIo = stdio,
): number {
  const plans = listPlans(cwd);
  if (options.json) {
    io.out(
      JSON.stringify(
        plans.map(({ file: _file, ...rest }) => ({
          ...rest,
          modified: new Date(rest.modifiedMs).toISOString(),
        })),
      ),
    );
    return 0;
  }
  if (!plans.length) {
    io.out("No plans in .continuous/plans. Plan mode writes them.");
    return 0;
  }
  io.out("STATUS      DONE   MODIFIED          PATH  TITLE");
  for (const row of formatPlanRows(plans)) io.out(row);
  return 0;
}

/**
 * Checks a plan can be built and returns the prompt for the run, or the
 * reason it cannot be. A plan with a decision still waiting is a draft: a run
 * nobody can answer would guess, so it needs `force`.
 */
export function preparePlanBuild(
  name: string,
  options: { force?: boolean },
  cwd = process.cwd(),
): { ok: true; file: string; prompt: string } | { ok: false; error: string } {
  const found = resolvePlan(name, cwd);
  if (!found.ok) return found;
  const summary = listPlans(cwd).find((p) => p.file === found.file);
  const status =
    summary?.status ??
    planStatusOf({ title: "", body: "", items: [], decisions: [] });
  if (status === "done") {
    return { ok: false, error: `${name} is done: every to-do is completed.` };
  }
  if (status === "draft" && !options.force) {
    return {
      ok: false,
      error: `${name} is a draft (no to-dos, or a decision still waits for an answer). Finish it in Plan mode or the file, or pass --force.`,
    };
  }
  const prompt = planBuildPrompt(cwd, found.file);
  return { ok: true, file: found.file, prompt };
}

export interface PlanBuildOptions extends ChatOptions {
  force?: boolean;
  print?: boolean;
}

export async function planBuildCommand(
  name: string,
  options: PlanBuildOptions,
  cwd = process.cwd(),
  io: PlanIo = stdio,
): Promise<number> {
  const prepared = preparePlanBuild(name, options, cwd);
  if (!prepared.ok) {
    io.err(prepared.error);
    return 2;
  }
  const headless =
    Boolean(options.print) || !process.stdin.isTTY || !process.stdout.isTTY;
  configureConsoleForHeadless(headless);
  logger.configureHeadlessMode(headless);
  activatePlanBuild(prepared.file, cwd);
  try {
    const { print: _print, force: _force, ...rest } = options;
    await chat(prepared.prompt, { ...rest, headless });
  } finally {
    deactivatePlanBuild();
  }
  return 0;
}

/**
 * Commander hands a flag to the first command on the line that declares it,
 * and the root `continuous` declares every flag `plan build` does, so
 * `continuous plan build a -p --config x` leaves the values on the root and
 * the subcommand sees none of them. Fills what the subcommand lacks from the
 * root (the same inheritance `serve` and `acp` use).
 */
export function inheritRootOptions<T extends Record<string, unknown>>(
  options: T,
  root: Command | null | undefined,
): T {
  const merged: Record<string, unknown> = { ...options };
  if (!root) return merged as T;
  for (const [key, value] of Object.entries(root.opts())) {
    const own = merged[key];
    const ownUnset = own === undefined || (Array.isArray(own) && !own.length);
    const rootSet =
      value !== undefined && !(Array.isArray(value) && !value.length);
    if (ownUnset && rootSet) merged[key] = value;
  }
  return merged as T;
}

/** Adds `continuous plan` with `list` and `build` to the program. */
export function registerPlanCommand(program: Command): void {
  const plan = program
    .command("plan")
    .description(
      "List and build the plan files Plan mode writes to .continuous/plans",
    );
  plan
    .command("list")
    .description(
      "List the workspace's plans: status, to-dos done/total, modified time, path",
    )
    .option("--json", "Machine-readable output")
    .action(async (options) => {
      await gracefulExit(planListCommand(options));
    });
  addRunLimitOptions(
    addCommonOptions(
      plan
        .command("build <name>")
        .description(
          "Run the agent on a plan (a name or a path inside .continuous/plans), from its first unchecked to-do; a to-do's check: is run by the harness",
        )
        .option("-p, --print", "Headless: run to the end without a TUI")
        .option("--force", "Build a draft plan with open decisions"),
    ),
  ).action(async (name: string, options, command: Command) => {
    const merged = inheritRootOptions(options, command.parent?.parent);
    const code = await planBuildCommand(name, merged);
    await gracefulExit(code);
  });
}
