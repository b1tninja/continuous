import type {
  ChatHistoryItem,
  Tool,
  ModelDescription,
  RuleWithSource,
  SessionEnvironment,
  TaskPlan,
} from "core";
import { renderEnvironment } from "core/util/environmentPrompt";
import { editFileTool } from "core/tools/definitions/editFile";
import { multiEditTool } from "core/tools/definitions/multiEdit";
import { presentPlanTool } from "core/tools/definitions/presentPlan";
import { readFileTool } from "core/tools/definitions/readFile";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { taskListTool } from "core/tools/definitions/taskList";
import { createLoop, startItemRun } from "core/util/loopMode";
import { getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";

/**
 * Test-only: the IDE request scenarios the prompt-segment tests build with the
 * real builders (buildChatRequest) over a mock store. Shared by the golden
 * request test (nothing sent may change) and the segment manifest tests.
 */

export const CLAUDE: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};
export const QWEN: ModelDescription = {
  title: "Qwen",
  model: "qwen3-coder:30b",
  provider: "ollama",
  underlyingProviderName: "ollama",
};
export const NOVA: ModelDescription = {
  title: "Nova",
  model: "amazon.nova-pro-v1:0",
  provider: "bedrock",
  underlyingProviderName: "bedrock",
};

const T0 = new Date("2026-11-07T10:00:00Z");
export const PLAN: TaskPlan = {
  items: [
    { id: "1", text: "Write the lexer", status: "completed" },
    { id: "2", text: "Add tests", status: "pending" },
  ],
  updatedAt: T0.toISOString(),
};

export const RULES: RuleWithSource[] = [
  {
    name: "always",
    rule: "Always answer in British English.",
    source: "rules-block" as any,
    alwaysApply: true,
  },
  {
    name: "ts-only",
    rule: "In TypeScript files prefer named exports.",
    source: "rules-block" as any,
    globs: "**/*.ts",
  },
];

/**
 * The scenarios' session environment: a fixed Linux machine with bash, in a
 * repository, rendered by the real renderer. With it the request carries the
 * real system line, the real terminal tool text with this shell sentence (in
 * place of the stand-in's), and the first-message block, the same on every
 * machine.
 */
export function scenarioEnvironment(): SessionEnvironment {
  const snapshot: SessionEnvironment["snapshot"] = {
    version: 1,
    takenAt: "2026-11-07T10:00:00.000Z",
    localDay: "2026-11-07",
    platform: "linux",
    arch: "x64",
    shell: {
      shell: { kind: "bash", source: "spawned", label: "bash" },
      executable: "/bin/bash",
      os: { value: "linux", confidence: "known", source: "platform linux" },
    },
    workspace: { home: "/home/dev", user: "dev", roots: ["file:///repo"] },
    git: { isRepo: true, branch: "main", statusZ: " M src/lexer.ts\0" },
  };
  const d = renderEnvironment(snapshot, {
    surface: "ide-agent",
    detail: "standard",
  });
  return {
    snapshot,
    detail: "standard",
    strings: {
      systemLine: d.systemLine,
      toolSentence: d.toolSentence,
      firstMessageBlock: d.firstMessageBlock,
    },
  };
}

// The real terminal tool describes the host OS and shell, so a fixed stand-in
// keeps the goldens the same on every platform; the session's shell sentence
// then replaces its text with the real tool's (withTerminalToolSentence).
const terminalStandIn: Tool = {
  type: "function",
  displayTitle: "Run Terminal Command",
  wouldLikeTo: "run a command",
  isCurrently: "running a command",
  hasAlready: "ran a command",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: "run_terminal_command",
    description: "Run a shell command and return its output.",
    parameters: {
      type: "object",
      required: ["command"],
      properties: { command: { type: "string" } },
    },
  },
};

const TOOLS = [
  readFileTool,
  editFileTool,
  multiEditTool,
  terminalStandIn,
  presentPlanTool,
  taskListTool,
];

let n = 0;
export const msg = (
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatHistoryItem> = {},
): ChatHistoryItem =>
  ({
    message: { id: `m${++n}`, role, content },
    contextItems: [],
    ...extra,
  }) as ChatHistoryItem;

export function ideState(opts: {
  model: ModelDescription;
  mode?: RootState["session"]["mode"];
  history?: ChatHistoryItem[];
  taskPlan?: TaskPlan;
  rules?: RuleWithSource[];
  loop?: boolean;
  onlySystemTools?: boolean;
}): RootState {
  const state = getEmptyRootState();
  const history = opts.history ?? [
    msg("user", "Fix the bug in lexer.ts"),
    msg("assistant", "Looking at it."),
    msg("user", "Now add a test."),
  ];
  const loop = opts.loop
    ? startItemRun(
        createLoop(PLAN, { now: T0, sessionTokens: 0 }),
        "2",
        history.length - 1,
        T0,
      )
    : undefined;
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        tools: TOOLS,
        rules: opts.rules ?? RULES,
        experimental: opts.onlySystemTools
          ? { onlyUseSystemMessageTools: true }
          : state.config.config.experimental,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: opts.model,
        },
      },
    },
    session: {
      ...state.session,
      mode: opts.mode ?? "agent",
      history: history as RootState["session"]["history"],
      taskPlan: opts.taskPlan,
      loop,
      environment: scenarioEnvironment(),
    },
  };
}

/** The IDE scenarios by name (C62 scenarios 1 to 5, and 9 and 10 in the IDE). */
/** The scoped rule listed before the global one, as a config may list them. */
export const SCOPED_FIRST_RULES: RuleWithSource[] = [RULES[1], RULES[0]];

export const IDE_SCENARIOS: Record<string, () => RootState> = {
  "ide-agent-claude": () => ideState({ model: CLAUDE }),
  "ide-agent-claude-tasklist": () =>
    ideState({ model: CLAUDE, taskPlan: PLAN }),
  "ide-plan-claude": () => ideState({ model: CLAUDE, mode: "plan" }),
  "ide-agent-qwen-prompted": () =>
    ideState({ model: QWEN, onlySystemTools: true }),
  "ide-agent-nova": () => ideState({ model: NOVA }),
  "ide-loop-item": () =>
    ideState({ model: CLAUDE, loop: true, taskPlan: PLAN }),
  "ide-agent-scoped-rule": () =>
    ideState({
      model: CLAUDE,
      history: [
        msg("user", "Fix the bug in lexer.ts", {
          contextItems: [
            {
              name: "lexer.ts",
              description: "",
              content: "export const a = 1;",
              uri: { type: "file", value: "file:///repo/src/lexer.ts" },
              id: { providerTitle: "file", itemId: "lexer" },
            },
          ],
        }),
      ],
    }),
  "ide-agent-scoped-first": () =>
    ideState({
      model: CLAUDE,
      rules: SCOPED_FIRST_RULES,
      history: [
        msg("user", "Fix the bug in lexer.ts", {
          contextItems: [
            {
              name: "lexer.ts",
              description: "",
              content: "export const a = 1;",
              uri: { type: "file", value: "file:///repo/src/lexer.ts" },
              id: { providerTitle: "file", itemId: "lexer" },
            },
          ],
        }),
      ],
    }),
  "ide-compacted": () =>
    ideState({
      model: CLAUDE,
      history: [
        msg("user", "Fix the bug in lexer.ts"),
        msg("assistant", "Done.", {
          conversationSummary: "The lexer bug was fixed.",
        }),
        msg("user", "Now add a test."),
      ],
    }),
};
