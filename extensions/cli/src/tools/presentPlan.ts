import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

import {
  answeredDecisions,
  choosePlanFileName,
  describeDecisions,
  PLAN_LIMITS,
  planBuildMessage,
  type PlanDecision,
  planKeepPlanningResult,
  PLANS_DIR,
  PRESENT_PLAN_CLI_TOOL_NAME,
  PRESENT_PLAN_DECISIONS_PARAMETER,
  PRESENT_PLAN_TODO_DETAILS_PARAMETER,
  PRESENT_PLAN_TOOL_DESCRIPTION,
  serializePlanFile,
  taskPlanForProposal,
  validatePlanArgs,
  planCheckSummary,
  weakCheckNotes,
} from "core/util/planFile.js";
import { TASK_PLAN_LIMITS, taskPlanToMarkdown } from "core/util/taskPlan.js";

import { safeStderr } from "../init.js";
import {
  getSessionLoop,
  isLoopEntry,
  requestLoopTurnEnd,
  startLoopFromPlan,
} from "../loop/loopSession.js";
import { writePlanText } from "../plans/planStore.js";
import { services } from "../services/index.js";
import { quizService } from "../services/QuizService.js";
import {
  getSessionPlanFile,
  getSessionTaskPlan,
  updateSessionPlanFile,
  updateSessionTaskPlan,
} from "../session.js";
import {
  answerIfIdgaf,
  questionsNeverAskHere,
} from "../util/idgafQuestions.js";
import { reloadPlanFile } from "../util/planFileReload.js";

import type { Tool } from "./types.js";

export const PRESENT_PLAN_BUILD = "Build";
export const PRESENT_PLAN_BUILD_IN_LOOP = "Build in a loop";
export const PRESENT_PLAN_KEEP_PLANNING = "Keep planning";

interface PresentPlanArgs {
  title?: unknown;
  plan?: unknown;
  todos?: unknown;
  todo_details?: unknown;
  decisions?: unknown;
}

function checkedArgs(args: PresentPlanArgs) {
  const parsed = validatePlanArgs(args ?? {});
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed;
}

/**
 * Writes the plan to `.continuous/plans/<slug>.md` under the working directory
 * and makes its to-dos the session's task list. Presenting again with the same
 * title replaces this session's file; a file of that name that belongs to
 * something else gets a numbered name.
 */
export async function savePlan(args: PresentPlanArgs, cwd = process.cwd()) {
  const parsed = checkedArgs(args);
  const result = taskPlanForProposal(parsed.items, getSessionTaskPlan());
  if (!result.ok) {
    throw new Error(result.error);
  }
  const dir = path.join(cwd, ...PLANS_DIR.split("/"));
  const ownFile = getSessionPlanFile();
  const fileName = await choosePlanFileName(parsed.title, (name) => {
    const file = path.join(dir, name);
    return pathToFileURL(file).href !== ownFile && fs.existsSync(file);
  });
  const file = path.join(dir, fileName);
  fs.mkdirSync(dir, { recursive: true });
  writePlanText(
    file,
    serializePlanFile({
      title: parsed.title,
      body: parsed.body,
      items: result.plan.items,
      decisions: parsed.decisions,
    }),
  );
  // The file first: the task list change re-renders the progress strip,
  // which shows the plan's name.
  updateSessionPlanFile(pathToFileURL(file).href);
  updateSessionTaskPlan(result.plan);
  return {
    file,
    relativePath: `${PLANS_DIR}/${fileName}`,
    plan: result.plan,
    decisions: parsed.decisions,
    /** Writes the file again with the person's answers to the decisions. */
    writeAnswers(answered: PlanDecision[]) {
      writePlanText(
        file,
        serializePlanFile({
          title: parsed.title,
          body: parsed.body,
          items: result.plan.items,
          decisions: answered,
        }),
      );
    },
  };
}

/**
 * The plan's decisions, asked one by one before the plan question: the
 * options as buttons with the model's pick as the default, or free text.
 */
async function askDecisions(
  decisions: PlanDecision[],
): Promise<PlanDecision[]> {
  const answers: { question: string; answer: string }[] = [];
  for (const [i, decision] of decisions.entries()) {
    const answer = await quizService.askQuestion({
      question: `Decision ${i + 1} of ${decisions.length}: ${decision.question}`,
      options: decision.options ?? [],
      defaultAnswer: decision.pick,
    });
    if (answer?.trim()) {
      answers.push({ question: decision.question, answer: answer.trim() });
    }
  }
  return answeredDecisions(decisions, answers);
}

/**
 * Questions is IDGAF: every open decision answered from what the plan offered
 * (the labelled option, the model's pick, the first option), one line each.
 */
function autoAnswerAll(decisions: PlanDecision[]): {
  decisions: PlanDecision[];
  lines: string[];
} {
  const answers: { question: string; answer: string }[] = [];
  const lines: string[] = [];
  for (const decision of decisions) {
    if (decision.answer?.trim()) continue;
    const auto = answerIfIdgaf({
      question: decision.question,
      options: decision.options,
      pick: decision.pick,
    });
    if (!auto) continue;
    answers.push({ question: decision.question, answer: auto.text });
    lines.push(auto.line);
  }
  return { decisions: answeredDecisions(decisions, answers), lines };
}

/**
 * Build: read the plan file back and make its checkboxes the task list
 * (src/util/planFileReload.ts).
 */
export { reloadPlanFile };

/**
 * Questions is IDGAF (ID 3): nobody is there to answer "Build this plan?", so
 * the turn ends with the plan saved instead of blocking, as the IDE's plan
 * card does. Nothing is built and nothing is asked.
 */
export function idgafPlanSavedResult(args: {
  relativePath: string;
  todos: number;
  open: number;
  autoLines: string;
  weak?: string;
}): string {
  const open = args.open
    ? ` Its ${args.open === 1 ? "decision waits" : `${args.open} decisions wait`} for the person in the file.`
    : "";
  return `Plan saved to ${args.relativePath} with ${args.todos} to-dos.${open}${args.autoLines}${args.weak ? ` ${args.weak}` : ""} Questions is IDGAF, so nobody was asked whether to build it and you are still in Plan mode: do not implement anything. End your turn now; the person builds it when they come back (Shift+Tab out of Plan mode, or \`continuous plan build ${args.relativePath}\`).`;
}

/** The plan question: Build, Build in a loop, Keep planning, or a change. */
function askBuild(relativePath: string, checks: string): Promise<string> {
  const shown = checks ? `\n\n${checks}\n\n` : " ";
  return quizService.askQuestion({
    question: `Build this plan? It is saved in ${relativePath}; edit the file first if you like.${shown}Or type what to change.`,
    options: [
      PRESENT_PLAN_BUILD,
      PRESENT_PLAN_BUILD_IN_LOOP,
      PRESENT_PLAN_KEEP_PLANNING,
    ],
    defaultAnswer: PRESENT_PLAN_BUILD,
  });
}

export const presentPlanTool: Tool = {
  name: PRESENT_PLAN_CLI_TOOL_NAME,
  displayName: "Present Plan",
  description: PRESENT_PLAN_TOOL_DESCRIPTION,
  // It writes only its own plan file under .continuous/plans, never the
  // person's code. It is offered in plan mode only (getAllAvailableTools).
  readonly: true,
  isBuiltIn: true,
  parameters: {
    type: "object",
    required: ["title", "plan", "todos"],
    properties: {
      title: {
        type: "string",
        description: `A short name for the work, at most ${PLAN_LIMITS.maxTitleLength} characters. It names the file in ${PLANS_DIR}.`,
      },
      plan: {
        type: "string",
        description:
          "The plan in markdown for a person to read: goal, approach, files involved, risks. Not the to-dos.",
      },
      todos: {
        type: "array",
        description: `The implementation steps in order, at most ${TASK_PLAN_LIMITS.maxItems}, each at most ${TASK_PLAN_LIMITS.maxTextLength} characters.`,
        items: { type: "string" },
      },
      todo_details: PRESENT_PLAN_TODO_DETAILS_PARAMETER as any,
      decisions: PRESENT_PLAN_DECISIONS_PARAMETER as any,
    },
  },
  preprocess: async (args: PresentPlanArgs) => {
    const parsed = checkedArgs(args);
    const preview = [
      { type: "text" as const, content: `Plan: ${parsed.title}` },
      ...(parsed.body
        ? [{ type: "text" as const, content: parsed.body, paddingLeft: 2 }]
        : []),
      ...(parsed.decisions.length
        ? [
            {
              type: "text" as const,
              content: parsed.decisions
                .map((d, i) => `Decision ${i + 1}: ${d.question}`)
                .join("\n"),
              paddingLeft: 2,
            },
          ]
        : []),
      {
        type: "checklist" as const,
        content: parsed.items.map((i) => `- [ ] ${String(i.text)}`).join("\n"),
      },
    ];
    return { args, preview };
  },
  run: async (args: PresentPlanArgs): Promise<string> => {
    const { file, relativePath, plan, decisions, writeAnswers } =
      await savePlan(args);

    // Loop mode's re-plan: the loop decides whether the new plan starts the
    // next round by itself (its autonomy level) or waits for the person in
    // the inbox, so nobody is asked here and the turn ends.
    const weak = weakCheckNotes(plan.items);
    if (getSessionLoop()?.current?.kind === "replan") {
      requestLoopTurnEnd();
      return `Plan saved to ${relativePath} with ${plan.items.length} to-dos.${weak ? ` ${weak}` : ""} End your turn now.`;
    }

    // Questions is IDGAF: the plan's open decisions are answered from what
    // the plan offered, in the file, before anything else (TUI and headless)
    let autoLines = "";
    let answeredDecisionsList = decisions;
    if (decisions.length > 0 && questionsNeverAskHere()) {
      const answered = autoAnswerAll(decisions);
      answeredDecisionsList = answered.decisions;
      writeAnswers(answeredDecisionsList);
      reloadPlanFile(file);
      autoLines = `\n${answered.lines.join("\n")}`;
    }
    const openDecisions = answeredDecisionsList.filter((d) => !d.answer);

    if (services.toolPermissions.isHeadless()) {
      // Nobody can approve: the file is the result. Its decisions wait in
      // the file for the person; the model must not settle them.
      safeStderr(`Plan saved to ${relativePath}\n`);
      const open = openDecisions.length
        ? ` Its ${openDecisions.length === 1 ? "decision waits" : `${openDecisions.length} decisions wait`} for the person in the file; do not settle ${openDecisions.length === 1 ? "it" : "them"}.`
        : "";
      return `Plan saved to ${relativePath} with ${plan.items.length} to-dos.${open}${autoLines}${weak ? ` ${weak}` : ""} This is a headless run, so nobody can approve it now: do not implement anything. Stop, and end your reply with the line "Plan: ${relativePath}".`;
    }

    // Questions is IDGAF: the plan is the result and the turn ends (ID 3)
    if (!isLoopEntry() && questionsNeverAskHere()) {
      requestLoopTurnEnd();
      return idgafPlanSavedResult({
        relativePath,
        todos: plan.items.length,
        open: openDecisions.length,
        autoLines,
        weak,
      });
    }

    // The decisions first, each with its options and the model's pick as the
    // default; the answers go into the file, so Build reads them back.
    let decided = answeredDecisionsList;
    if (openDecisions.length > 0 && !isLoopEntry()) {
      decided = await askDecisions(answeredDecisionsList);
      writeAnswers(decided);
    }
    const decisionLines = [describeDecisions(decided), autoLines.trim()]
      .filter(Boolean)
      .join("\n");
    const withDecisions = (text: string) =>
      decisionLines ? `${text}\n\n${decisionLines}` : text;

    // The loop entry (Shift+Tab): the person already chose to build in a loop
    const answer = isLoopEntry()
      ? PRESENT_PLAN_BUILD_IN_LOOP
      : await askBuild(relativePath, planCheckSummary(plan.items));

    if (answer === PRESENT_PLAN_BUILD) {
      reloadPlanFile(file);
      services.toolPermissions.switchMode("normal");
      return `The user approved the plan and switched out of plan mode, so you can now edit files (each edit asks for approval). ${withDecisions(planBuildMessage(relativePath))}\n\nCurrent task list:\n${taskPlanToMarkdown(getSessionTaskPlan())}`;
    }
    if (answer === PRESENT_PLAN_BUILD_IN_LOOP) {
      // Loop mode: the CLI runs the to-dos one at a time, each in its own
      // turn with a fresh context (src/loop/loopDriver.ts). This turn ends.
      services.toolPermissions.switchMode("normal");
      if (startLoopFromPlan("normal")) {
        requestLoopTurnEnd();
        return "The user approved the plan and chose to build it in a loop: each to-do will be given to you on its own turn. Do not start on it now; end your turn.";
      }
      reloadPlanFile(file);
      return `The user approved the plan and switched out of plan mode. ${withDecisions(planBuildMessage(relativePath))}`;
    }
    return planKeepPlanningResult(
      answer === PRESENT_PLAN_KEEP_PLANNING ? undefined : answer,
    );
  },
};
