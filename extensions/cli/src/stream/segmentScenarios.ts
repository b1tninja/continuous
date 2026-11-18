import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionTool } from "openai/resources.mjs";
import { vi } from "vitest";

import {
  environmentContextBlock,
  resetEnvironmentContextBlock,
} from "../environmentContext.js";
import { multiEditTool } from "../tools/multiEdit.js";
import { presentPlanTool } from "../tools/presentPlan.js";
import { readFileTool } from "../tools/readFile.js";
import { taskListTool } from "../tools/taskList.js";
import { writeFileTool } from "../tools/writeFile.js";

/**
 * Test-only: the CLI request scenarios of the prompt-segment tests. The system
 * message is the real `constructSystemMessage` over a fixed folder holding an
 * AGENTS.md and a rules file, the tools are real definitions, and the request
 * is the real `buildChatRequestBody`. Shared by the golden request test and
 * the manifest tests.
 */

// The resolved temp folder: on macOS os.tmpdir() is under /var, a link to
// /private/var, and after chdir the working directory is the /private spelling,
// which normalize() would not replace. On Windows it expands an 8.3 name.
export const SCENARIO_DIR = path.join(
  fs.realpathSync.native(os.tmpdir()),
  "cli-segment-scenario",
);
export const MODEL_ID = "claude-sonnet-4-6";

export interface CliScenarioSpec {
  mode: "normal" | "plan";
  /** A subagent's own prompt, joined after the base message as the executor does. */
  subagentPrompt?: string;
  history: ChatHistoryItem[];
  taskListBlock?: string;
  turnTail?: string;
  isCompacting?: boolean;
  /** Fake MCP tool names, in connection order. */
  mcp?: string[];
  /** The environment block's date. */
  date?: string;
}

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

export const HISTORY: ChatHistoryItem[] = [
  user("Fix the bug in lexer.ts"),
  assistant("Looking at it."),
  user("Now add a test."),
];

export const SCENARIOS: Record<string, CliScenarioSpec> = {
  "cli-agent": {
    mode: "normal",
    history: HISTORY,
    taskListBlock: "<task_list>\n[>] 1. Add a test\n</task_list>",
    mcp: ["mcp__a__search", "mcp__b__fetch", "mcp__c__list"],
  },
  "cli-agent-plain": { mode: "normal", history: HISTORY },
  "cli-plan": { mode: "plan", history: HISTORY },
  "cli-subagent": {
    mode: "normal",
    subagentPrompt: "You review diffs and report only defects.",
    history: [user("Review the last commit.")],
  },
  "cli-compaction": {
    mode: "normal",
    isCompacting: true,
    history: [...HISTORY, user("<compaction prompt>")],
  },
  "cli-resume": { mode: "normal", history: HISTORY, date: "2026-11-09" },
};

function fakeMcp(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: "object", properties: {} },
    },
  };
}

interface CliTool {
  name: string;
  description: string;
  parameters: { required?: string[]; properties: unknown };
}

function toChatTool(t: CliTool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        required: t.parameters.required,
        properties: t.parameters.properties as Record<string, unknown>,
      },
    },
  };
}

export function scenarioTools(spec: CliScenarioSpec): ChatCompletionTool[] {
  const builtins = [
    readFileTool,
    writeFileTool,
    // The real Bash tool describes the host OS, so a fixed stand-in keeps
    // the goldens the same on every platform.
    {
      name: "Bash",
      description: "Run a shell command and return its output.",
      parameters: {
        required: ["command"],
        properties: { command: { type: "string" } },
      },
    },
    ...(spec.taskListBlock ? [taskListTool] : []),
    multiEditTool,
    ...(spec.mode === "plan" ? [presentPlanTool] : []),
  ] as unknown as CliTool[];
  return [...builtins.map(toChatTool), ...(spec.mcp ?? []).map(fakeMcp)];
}

/** Writes the instruction files the system message reads and enters the folder. */
export function enterScenarioDir(): void {
  fs.mkdirSync(path.join(SCENARIO_DIR, ".continue", "rules"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(SCENARIO_DIR, "AGENTS.md"),
    "# Project\nUse pnpm. Run the tests after a change.\n",
  );
  fs.writeFileSync(
    path.join(SCENARIO_DIR, ".continue", "rules", "style.md"),
    "---\nname: style\n---\nPrefer named exports.\n",
  );
  process.chdir(SCENARIO_DIR);
}

/** Machine-specific facts replaced by fixed words, so a hash is portable. */
export function normalize(text: string): string {
  return text
    .split(SCENARIO_DIR)
    .join("<CWD>")
    .split(SCENARIO_DIR.replace(/\\/g, "\\\\"))
    .join("<CWD>")
    .replace(/Platform: \w+/g, "Platform: <PLATFORM>")
    .replace(/Is directory a git repo: \w+/g, "Is directory a git repo: <GIT>");
}

export interface CliScenarioRequest {
  systemMessage: string;
  tools: ChatCompletionTool[];
  /** The request body's messages, as sent. */
  messages: unknown[];
  environmentBlock: string;
  spec: CliScenarioSpec;
}

/**
 * Builds a scenario's request with the real builders. `vi.mock` of the service
 * container (no config rules) must be in effect in the calling test.
 */
export async function buildCliScenario(
  spec: CliScenarioSpec,
): Promise<CliScenarioRequest> {
  // vitest.setup.ts mocks the module for other tests: take the real one
  const { constructSystemMessage } = await vi.importActual<
    typeof import("../systemMessage.js")
  >("../systemMessage.js");
  const { buildChatRequestBody } = await import("./requestBody.js");
  // The user's own settings file must not leak into a golden.
  const priorGlobalDir = process.env.CONTINUOUS_GLOBAL_DIR;
  process.env.CONTINUOUS_GLOBAL_DIR = path.join(
    os.tmpdir(),
    "continuous-golden-no-settings",
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${spec.date ?? "2026-11-10"}T09:00:00Z`));
  resetEnvironmentContextBlock();
  try {
    // Machine facts (folder, platform) become fixed words: hashes are portable.
    const base = normalize(
      await constructSystemMessage(spec.mode, undefined, undefined, false, {
        model: MODEL_ID,
      }),
    );
    const systemMessage = spec.subagentPrompt
      ? `${base}\n\n${spec.subagentPrompt}`
      : base;
    const tools = scenarioTools(spec);
    const body = buildChatRequestBody({
      model: { name: "m", provider: "anthropic", model: MODEL_ID } as never,
      chatHistory: spec.history,
      systemMessage,
      tools,
      taskListBlock: spec.taskListBlock,
      isCompacting: spec.isCompacting,
      turnTail: spec.turnTail,
    });
    return {
      systemMessage,
      tools,
      messages: body.messages,
      environmentBlock: environmentContextBlock(),
      spec,
    };
  } finally {
    vi.useRealTimers();
    if (priorGlobalDir === undefined) delete process.env.CONTINUOUS_GLOBAL_DIR;
    else process.env.CONTINUOUS_GLOBAL_DIR = priorGlobalDir;
  }
}
