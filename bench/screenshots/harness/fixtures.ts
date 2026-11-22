// Fixture states for the screenshot harness. Each fixture dispatches the real
// redux actions the app uses (the same ones the gui tests use), against the
// real store, with MockIdeMessenger standing in for the IDE. Nothing here is
// sent anywhere: no model, no network.
import type {
  ChatHistoryItem,
  LoopState,
  ModelDescription,
  TaskPlan,
  ToolCallState,
} from "core";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { parsePolicyFile } from "core/tools/permissions/settingsFile";
import { createLoop, enterWait, stopLoop } from "core/util/loopMode";
import { addBlockedCall } from "@gui/redux/slices/blockedCallsSlice";
import { setPolicyLevel } from "@gui/redux/slices/uiSlice";
import { POLICY_AREAS } from "core/tools/permissions/policy";
import { McpServerDialog } from "@gui/components/McpServerDialog/McpServerDialog";
import {
  ModelConfigDialog,
  type ModelConfigTab,
} from "@gui/components/ModelConfig/ModelConfigDialog";
import { ProviderSetupFlow } from "@gui/components/ProviderSetup/ProviderSetupFlow";
import type { MockIdeMessenger } from "@gui/context/MockIdeMessenger";
import {
  addRequestUsageToSession,
  enqueueMessage,
  newSession,
  setAllSessionMetadata,
  setContextPercentage,
  setMainEditorContentTrigger,
  setLoop,
  setPromptCacheState,
  noteToolDialectLeak,
  setActive,
  setMode,
  setRecoveryHold,
  setTaskPlan,
} from "@gui/redux/slices/sessionSlice";
import {
  setDialogMessage,
  setOnboardingCard,
  setShowDialog,
  setToolPolicy,
} from "@gui/redux/slices/uiSlice";
import { createElement } from "react";
import type { setupStore } from "@gui/redux/store";
import { AUDIT_FIXTURES } from "./auditFixtures";
import { installWalkMock } from "./walkMock";

export type Store = ReturnType<typeof setupStore>;
export interface FixtureContext {
  store: Store;
  messenger: MockIdeMessenger;
  /** Sends a message as the IDE would (navigation, config updates ...) */
  navigate: (path: string) => void;
}
export type Fixture = (ctx: FixtureContext) => void | Promise<void>;

/** A fixed clock so budgets and ages draw the same on every run. */
const NOW = new Date("2026-11-10T10:00:00Z");

export const CHAT_MODEL: ModelDescription = {
  title: "Claude Sonnet",
  model: "claude-sonnet-4-5",
  provider: "bedrock",
  underlyingProviderName: "bedrock",
  contextLength: 200_000,
} as ModelDescription;

/** Seeds the answers the app asks the IDE for at start, before it mounts. */
export function seedMessenger(messenger: MockIdeMessenger): void {
  const info: any = structuredClone(
    messenger.responses["config/getSerializedProfileInfo"],
  );
  info.result.config.modelsByRole.chat = [CHAT_MODEL];
  info.result.config.selectedModelByRole.chat = CHAT_MODEL;
  messenger.responses["config/getSerializedProfileInfo"] = info;
  Object.assign(messenger.responses, {
    "models/fetch": [],
    // The setup flow's start screen asks; nothing is running unless a fixture says so
    "models/detectLocal": [],
    "config/getTerminalEnvironment": {
      mode: "scrub",
      source: "default",
      passEnv: [],
      allow: [],
      notices: [],
      hostEnvNames: ["PATH", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "EDITOR"],
      credentialUrlNames: [],
    },
    "audit/shadowSettings": {
      form: { enabled: false, timeoutMs: 5000 },
      trailEnabled: true,
      spentUsd: 0,
      reservedUsd: 0,
      reviews: 0,
    },
    getOpenFiles: [],
    "policy/load": parsePolicyFile(undefined),
    "config/getProviderSetup": {
      connections: [],
      secureStorageAvailable: true,
      preferredKeyStorage: "secure",
      editable: true,
    },
  });
}

/** What the IDE would send after loading the config: puts the model in the store. */
export function sendConfig(messenger: MockIdeMessenger): void {
  const info: any = messenger.responses["config/getSerializedProfileInfo"];
  messenger.mockMessageToWebview("configUpdate", info);
}

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}
function assistant(
  text: string,
  toolCallStates?: ToolCallState[],
): ChatHistoryItem {
  return {
    message: { role: "assistant", content: text },
    contextItems: [],
    toolCallStates,
  };
}
function session(history: ChatHistoryItem[], title = "Fix the failing test") {
  return {
    sessionId: "fixture-session",
    title,
    workspaceDirectory: "file:///c:/work/app",
    history,
  };
}

const MARKDOWN_REPLY = [
  "The failure is in `parseConfig`: it reads `opts.timeout` before the defaults are merged, so a missing value becomes `undefined`.",
  "",
  "```ts",
  "export function parseConfig(opts: Partial<Config> = {}) {",
  "  const merged = { ...DEFAULTS, ...opts };",
  "  return { ...merged, timeout: merged.timeout * 1000 };",
  "}",
  "```",
  "",
  "- merge the defaults first",
  "- convert the unit last",
].join("\n");

/** The rest of a question long enough to fill a short panel. */
const LONG_QUESTION =
  "Its checks ran against the old runner, the branch is forty commits behind main, and two of its files were moved by the migration since. Merging it as it is keeps the history simple but may break the gate; leaving it open keeps the gate green and the work unfinished. Which do you want?";

function runCommandCall(status: ToolCallState["status"]): ToolCallState {
  return {
    toolCallId: "call-1",
    toolCall: {
      id: "call-1",
      type: "function",
      function: {
        name: "run_terminal_command",
        arguments: JSON.stringify({ command: "npm test -- parseConfig" }),
      },
    },
    status,
    parsedArgs: { command: "npm test -- parseConfig" },
    output:
      status === "done"
        ? [
            {
              name: "Terminal",
              description: "Terminal command output",
              content:
                "PASS  src/parseConfig.test.ts\n  parseConfig\n    ok defaults are merged first (3 ms)\n\nTests: 1 passed, 1 total",
            },
          ]
        : undefined,
  } as ToolCallState;
}

const PLAN: TaskPlan = {
  items: [
    {
      id: "1",
      text: "Reproduce the failure with a test",
      status: "done",
    },
    {
      id: "2",
      text: "Merge the defaults before converting the unit",
      status: "in_progress",
      budget: { tokens: 20_000, minutes: 10, turns: 20 },
    },
    {
      id: "3",
      text: "Run the whole suite",
      status: "pending",
      budget: { tokens: 10_000, minutes: 5 },
    },
  ],
  updatedAt: NOW.toISOString(),
} as TaskPlan;

function loopScene(
  store: Store,
  change: (loop: LoopState) => LoopState,
  // A running loop takes its next step when nothing streams, which in the
  // harness ends in an error; a turn in flight keeps the picture still
  inFlight = false,
): void {
  store.dispatch(newSession(session([], "Fix parseConfig")));
  store.dispatch(setMode("loop" as never));
  store.dispatch(setTaskPlan(PLAN));
  store.dispatch(setLoop(change(loopState())));
  if (inFlight) store.dispatch(setActive());
}

function loopState(): LoopState {
  // the real clock: a loop whose start is far in the past is stopped by its own time budget
  const loop = createLoop(PLAN, {
    now: new Date(),
    sessionTokens: 0,
    autonomy: "auto",
  });
  loop.items = loop.items.map((item) =>
    item.id === "2"
      ? { ...item, attempts: 1, usage: { tokens: 9_000, ms: 150_000 } }
      : item,
  );
  // waiting on the person: the loop controller does not start a turn of its own
  return enterWait(loop, new Date());
}

/** Set a controlled input's value the way typing does, so React sees it. */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Permissions page with the add-rule form open on a rule that allows every command. */
const permissionsEditor: Fixture = async ({ messenger, navigate }) => {
  const report = {
    ...listEffectiveRules({
      levels: DEFAULT_POLICY_LEVELS,
      floor: ["runTerminalCommand(rm -rf /*)"],
      user: {
        deny: ["runTerminalCommand(terraform apply*)"],
        ask: ["runTerminalCommand(git push*)"],
        allow: ["runTerminalCommand(npm test*)"],
      },
      folder: [
        {
          file: "C:/work/app/.continue/rules.yaml",
          permissions: { allow: ["runTerminalCommand(make build*)"] },
        },
      ],
    }),
    userFile: { path: "config.yaml", state: "ok" as const, hash: "h1" },
  };
  Object.assign(messenger.responses, {
    "policy/rules": report,
    "config/addToolRule": {
      result: "preview",
      analysis: {
        valid: true,
        rule: "runTerminalCommand(*)",
        broad: true,
        broadReason: "It matches every command.",
        friction: "typed",
        loosens: true,
        warnings: [],
      },
      diff: [
        { kind: "same", text: "toolPermissions:" },
        { kind: "add", text: "  allow:" },
        { kind: "add", text: "    - runTerminalCommand(*)" },
      ],
      verdict: {
        probe: "rm notes.txt",
        before: { decision: "ask", reason: "level" },
        after: { decision: "allow", reason: "rule" },
      },
    },
  });
  navigate("/config?tab=permissions&view=rules");
  await wait(600);
  const add = document.querySelector<HTMLButtonElement>(
    "button[aria-label='Add a rule']",
  );
  add?.click();
  await wait(100);
  const input = document.querySelector<HTMLInputElement>(
    "form[data-testid=rule-form] input.font-mono",
  );
  if (input) typeInto(input, "runTerminalCommand(*)");
  await wait(700);
  document
    .querySelector("[data-testid=rule-form]")
    ?.scrollIntoView({ block: "start" });
};

// ---- Loop mode: the plan tile and its tree ---------------------------------

const TILE_TITLES = [
  "Port sdk-forge/loop.py pickup to the projecthub CLI",
  "Move the roadmap sync onto projecthub issues",
  "Point every project AGENTS.md at the projecthub plan",
  "Move verify.py's five gates into projecthub",
  "Retire the sdk-forge githooks path and re-point core.hooksPath",
  "Write the migration note in PORTFOLIO.md",
  "Run the whole suite from a clean checkout",
  "Tag the release",
];

const PLAN_URI =
  "file:///c:/work/app/.continuous/plans/finish-the-migration.md";

function planCall(): ToolCallState {
  return {
    toolCallId: "plan-1",
    toolCall: {
      id: "plan-1",
      type: "function",
      function: { name: "present_plan", arguments: "{}" },
    },
    parsedArgs: {
      title: "Finish the sdk-forge to projecthub migration",
      plan: "Move the planning tools onto projecthub, one project at a time.",
      todos: TILE_TITLES,
    },
    status: "done",
    output: [
      {
        name: "Finish the sdk-forge to projecthub migration",
        description: ".continuous/plans/finish-the-migration.md",
        content: "Plan saved",
        uri: { type: "file", value: PLAN_URI },
      },
    ],
  } as ToolCallState;
}

function tilePlan(texts = TILE_TITLES): TaskPlan {
  return {
    items: texts.map((text, i) => ({
      id: String(i + 1),
      text,
      status: "pending" as const,
      ...(i === 1 ? { budget: { turns: 12 } } : {}),
    })),
    updatedAt: NOW.toISOString(),
  } as TaskPlan;
}

function toolTurn(command: string): ChatHistoryItem {
  return assistant("", [
    {
      toolCallId: "t-" + command.length,
      toolCall: {
        id: "t-" + command.length,
        type: "function",
        function: {
          name: "run_terminal_command",
          arguments: JSON.stringify({ command }),
        },
      },
      status: "done",
      parsedArgs: { command },
    } as ToolCallState,
  ]);
}

type LoopPatch = (loop: LoopState, plan: TaskPlan) => LoopState;

/** The plan card at the head of a Loop session, with the loop in the state `patch` sets */
function tileFixture(opts: {
  patch: LoopPatch;
  plan?: TaskPlan;
  /** The plan the loop was created from, when it differs (a re-plan waits) */
  loopPlan?: TaskPlan;
  history?: ChatHistoryItem[];
  /** Open the tree with a click, as a person would */
  open?: boolean;
}): Fixture {
  return async ({ store }) => {
    const plan = opts.plan ?? tilePlan();
    const base = createLoop(opts.loopPlan ?? plan, {
      now: new Date(Date.now() - 400_000),
      sessionTokens: 0,
      autonomy: "auto",
      title: "Finish the sdk-forge to projecthub migration",
    });
    const patched = opts.patch({ ...base, round: 2 }, plan);
    store.dispatch(
      newSession(
        session(
          [
            user("Plan the migration, then build it"),
            assistant("", [planCall()]),
            ...(opts.history ?? []),
          ],
          "Finish the migration",
        ),
      ),
    );
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(plan));
    store.dispatch(setLoop(patched));
    // a turn is running: the loop driver leaves a running loop alone
    if (patched.status === "running") store.dispatch(setActive());
    if (opts.open) {
      await new Promise((r) => setTimeout(r, 600));
      (
        document.querySelector(
          "[data-testid=plan-tree-root] > div",
        ) as HTMLElement | null
      )?.click();
      // and the fold of the finished items, to show what was replaced
      await new Promise((r) => setTimeout(r, 100));
      (
        document.querySelector(
          "[data-testid=plan-tree-fold-done] > div",
        ) as HTMLElement | null
      )?.click();
    }
  };
}

const withItems =
  (statuses: Record<string, Partial<LoopState["items"][number]>>) =>
  (loop: LoopState): LoopState => ({
    ...loop,
    items: loop.items.map((i) => ({ ...i, ...statuses[i.id] })),
  });

export const FIXTURES: Record<string, Fixture> = {
  /** Loop mode, the plan tile: collapsed, one click to audit */
  "loop-plan-tile": tileFixture({
    patch: (loop) => ({
      ...withItems({
        "1": { status: "done" },
        "2": { status: "running", attempts: 1 },
      })(loop),
      current: {
        kind: "item",
        itemId: "2",
        historyIndex: 2,
        startedAt: new Date(Date.now() - 130_000).toISOString(),
      },
    }),
  }),
  /** Loop mode, the plan tree open: done fold, the current item with its live lines, upcoming rows */
  "loop-plan-running": tileFixture({
    open: true,
    history: [
      toolTurn("pytest -q tests/test_roadmap.py"),
      toolTurn('pip install -e ".[dev]"'),
    ],
    patch: (loop) =>
      ({
        ...withItems({
          "1": { status: "done" },
          "2": { status: "running", attempts: 1, addedInRound: 2 },
        })(loop),
        current: {
          kind: "item",
          itemId: "2",
          historyIndex: 2,
          startedAt: new Date(Date.now() - 130_000).toISOString(),
        },
        replacedItems: [
          {
            id: "0",
            text: "Re-run the gates on the PR head",
            round: 2,
            replacedBy: "2",
          },
        ],
        autoDecisions: [
          {
            kind: "plan",
            by: "system",
            source: "Plan edits: Permissive",
            text: "Plan updated: 7 kept, 1 added, 1 dropped; check of item 1 replaced",
            at: new Date().toISOString(),
          },
          {
            kind: "question",
            by: "system",
            source: "Questions: Permissive",
            text: "Auto-answered: Merge PR #7 as-is? -> Merge it after writing the gate record",
            at: new Date().toISOString(),
          },
        ],
      }) as LoopState,
  }),
  /** Loop mode, a re-plan waiting to be accepted: dropped struck through, new to-do, kept folded */
  "loop-plan-waiting": (() => {
    const previous = TILE_TITLES.slice();
    const next = tilePlan([
      TILE_TITLES[0],
      "Write PR #7's gate record to the log",
      ...TILE_TITLES.slice(2),
    ]);
    // the new to-do has an id the loop does not know
    next.items[1] = { ...next.items[1], id: "9" };
    return tileFixture({
      plan: next,
      loopPlan: tilePlan(),
      patch: (loop) => ({
        ...withItems({ "1": { status: "done" } })(loop),
        status: "awaiting_plan" as const,
        replanReason:
          "It changes or removes the check of item 2, which ended stuck without running it.",
        replanned: { planTexts: previous },
      }),
    });
  })(),
  /** Loop mode, an item failed and a repair re-plan runs */
  "loop-plan-failed": tileFixture({
    history: [toolTurn("pytest -q")],
    patch: (loop) => ({
      ...withItems({
        "1": { status: "done" },
        "2": {
          status: "failed",
          attempts: 2,
          check: {
            status: "failed",
            command: "pytest -q",
            exitCode: 1,
            output: "collected 12 items\n2 failed, 10 passed in 3.4s",
            at: new Date().toISOString(),
          },
        },
      })(loop),
      current: {
        kind: "replan",
        itemId: "2",
        itemText: TILE_TITLES[1],
        historyIndex: 2,
        startedAt: new Date(Date.now() - 20_000).toISOString(),
      },
    }),
  }),
  /** Loop mode, finished: one fold, the root says N/N done */
  "loop-plan-finished": tileFixture({
    patch: (loop) => ({
      ...withItems(
        Object.fromEntries(
          TILE_TITLES.map((_, i) => [
            String(i + 1),
            { status: "done" as const },
          ]),
        ),
      )(loop),
      status: "stopped" as const,
    }),
  }),
  /** A new, empty chat */
  idle: ({ store }) => {
    store.dispatch(newSession());
  },
  /** A finished exchange, markdown and a code block */
  conversation: ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          assistant(MARKDOWN_REPLY),
        ]),
      ),
    );
  },
  /**
   * One reply whose markdown the render check supplies: render.mjs sets
   * window.__renderMarkdown before the page loads
   */
  "render-markdown": ({ store }) => {
    const markdown = (window as { __renderMarkdown?: string }).__renderMarkdown;
    store.dispatch(
      newSession(
        session(
          [user("Render this."), assistant(markdown ?? MARKDOWN_REPLY)],
          "Render check",
        ),
      ),
    );
  },
  /** A reply that is still arriving */
  streaming: async ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          assistant(MARKDOWN_REPLY.slice(0, 120)),
        ]),
      ),
    );
    store.dispatch({ type: "session/setActive" });
  },
  /** A tool call card waiting for approval, then one that finished */
  "tool-call": ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Run the parseConfig tests"),
          assistant("I will run the tests for that file.", [
            runCommandCall("generated"),
          ]),
        ]),
      ),
    );
  },
  /** Three calls waiting: a long command, a directory outside the workspace, an MCP tool */
  approval: ({ store }) => {
    const call = (
      id: string,
      name: string,
      args: Record<string, unknown>,
      extra: Partial<ToolCallState> = {},
    ): ToolCallState => ({
      toolCallId: id,
      toolCall: {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
      status: "generated",
      parsedArgs: args,
      ...extra,
    });
    store.dispatch(
      newSession(
        session([
          user("Clean up and look around"),
          assistant("I need to run a few things.", [
            call("call-1", "run_terminal_command", {
              command:
                "cd packages/app && API_TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 npm run build \\\n  && rsync -av --delete dist/ deploy@staging.example.com:/var/www/app/ \\\n  && ssh deploy@staging.example.com 'sudo systemctl restart app && sudo journalctl -u app -n 50'\n# afterwards\necho done",
              cwd: "D:/code/app",
            }),
            call(
              "call-2",
              "ls",
              { dirPath: "D:/" },
              {
                policyNote:
                  "This reaches D:/, outside the workspace, a place the agent has not been given. Approve only if you meant it.",
                policyRule: "ls(D:/**)",
                policySource: "ask-rule",
              },
            ),
            call(
              "call-3",
              "github_create_issue",
              {
                repo: "b1tninja/continuous",
                title: "Approval row",
                labels: ["ux"],
              },
              {
                tool: {
                  type: "function",
                  function: { name: "github_create_issue" },
                  displayTitle: "create_issue",
                  group: "github",
                  originalFunctionName: "create_issue",
                  readonly: false,
                } as ToolCallState["tool"],
              },
            ),
          ]),
        ]),
      ),
    );
  },
  /** A short panel's worst case: an approval waiting, a task list open, two queued messages */
  "crowded-stack": async ({ store }) => {
    const text = (t: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
    });
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          assistant(MARKDOWN_REPLY),
          user("Fix it and run the tests"),
          assistant(
            "I merged the defaults first. Now I will run the tests for that file.",
            [runCommandCall("generated")],
          ),
        ]),
      ),
    );
    store.dispatch(setTaskPlan(PLAN));
    for (const t of [
      "Also update the changelog",
      "Then open a pull request against main",
    ]) {
      store.dispatch(
        enqueueMessage({ editorState: text(t), modifiers: {} as never }),
      );
    }
    await new Promise((r) => setTimeout(r, 300));
    (
      document.querySelector("[data-testid=task-list-toggle]") as HTMLElement
    )?.click();
  },
  "tool-call-done": ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Run the parseConfig tests"),
          assistant("I ran the tests for that file.", [runCommandCall("done")]),
          assistant("All of them pass."),
        ]),
      ),
    );
  },
  /** A reply held back while the app checks it for a tool request */
  held: ({ store }) => {
    store.dispatch(
      newSession(
        session([user("Why does the parseConfig test fail?"), assistant("")]),
      ),
    );
    store.dispatch({ type: "session/setActive" });
    store.dispatch(setRecoveryHold(true));
  },
  /** A model wrote a tool request as plain text: the notice above the input */
  dialect: ({ store }) => {
    store.dispatch(newSession());
    store.dispatch(
      noteToolDialectLeak({
        model: "Claude Sonnet",
        dialect: "qwen-xml",
      } as never),
    );
  },
  /** The "+" menu at the left of the prompt, open */
  "attach-open": async ({ store }) => {
    store.dispatch(newSession());
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector("[data-testid=attach-menu-button]") as HTMLElement
    )?.click();
  },
  /** A conversation with usage: the row under the prompt, every control in it */
  "status-row": ({ store }) => statusRowScene(store),
  /** The same, with the usage breakdown opened from the readout */
  "usage-open": async ({ store }) => {
    statusRowScene(store);
    await new Promise((r) => setTimeout(r, 800));
    // The last one: earlier messages keep a hidden toolbar of their own
    const readouts = document.querySelectorAll<HTMLElement>(
      "[data-testid=usage-indicator]",
    );
    readouts[readouts.length - 1]?.click();
    // Let the popover be placed above the readout before the picture
    await new Promise((r) => setTimeout(r, 300));
  },
  /** What the context holds, opened from the context meter beside the cost */
  "context-open": async ({ store }) => {
    contextScene(store);
    await new Promise((r) => setTimeout(r, 800));
    const meters = document.querySelectorAll<HTMLElement>(
      "[data-testid=context-meter]",
    );
    meters[meters.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 300));
  },
  /** The preset picker in the toolbar, open: glyph, what each sets, the check */
  "preset-open": async ({ store }) => {
    store.dispatch(newSession());
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector("[data-testid=policy-preset]") as HTMLElement
    )?.click();
  },
  /** Loop mode: the plan card, the per-item budgets and the loop controls */
  loop: ({ store }) => {
    store.dispatch(newSession(session([], "Fix parseConfig")));
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loopState()));
  },
  /** Loop mode, running item 2: the status line, "Now:" and the progress */
  "loop-running": ({ store }) => {
    loopScene(
      store,
      (loop) => ({
        ...loop,
        title: "Fix parseConfig so defaults merge before the unit converts",
        status: "running",
        waitingSince: undefined,
        current: {
          kind: "item",
          itemId: "2",
          historyIndex: 0,
          startedAt: new Date().toISOString(),
        },
      }),
      true,
    );
  },
  /** Three questions wait on the person: the tray shows one, with a pager */
  "loop-questions": ({ store }) => {
    const question = (id: string, text: string) => ({
      id,
      itemId: "2",
      question: text,
      kind: "blocking" as const,
      options: [
        "Merge it as it is (recommended)",
        "Leave it open",
        "Write the record first",
      ],
      askedAt: new Date().toISOString(),
    });
    loopScene(store, (loop) => ({
      ...loop,
      status: "waiting",
      questions: [
        question(
          "q1",
          "PR #7 is open and green by its own report. Should I merge it as-is, or wait for you?",
        ),
        question("q2", "Which branch should the migration land on?"),
        question("q3", "Do you want the gate record written into the repo?"),
      ],
    }));
  },
  /** A plan leaves three long decisions to the person, after a conversation: the Questions panel in a short panel */
  "tall-question": ({ store }) => {
    const decision = (question: string) => ({
      question: `${question} ${LONG_QUESTION}`,
      options: ["Merge it as it is", "Leave it open"],
      pick: "Merge it as it is",
    });
    const call = planCall();
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          assistant(MARKDOWN_REPLY),
          user("Plan the migration"),
          assistant("Here is the plan. Three things are yours to decide.", [
            {
              ...call,
              parsedArgs: {
                ...call.parsedArgs,
                decisions: [
                  decision("PR #7 is open and green by its own report."),
                  decision("The migration can land on main or on a branch."),
                  decision("The gate record is not in the repo yet."),
                ],
              },
            },
          ]),
        ]),
      ),
    );
  },
  /** A loop asks one long question, after a conversation: the Needs you tray in a short panel */
  "loop-tall-question": ({ store }) => {
    store.dispatch(
      newSession(
        session(
          [
            user("Why does the parseConfig test fail?"),
            assistant(MARKDOWN_REPLY),
          ],
          "Fix parseConfig",
        ),
      ),
    );
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(
      setLoop({
        ...loopState(),
        status: "waiting",
        questions: [
          {
            id: "q1",
            itemId: "2",
            question: `PR #7 is open and green by its own report. ${LONG_QUESTION} ${LONG_QUESTION}`,
            kind: "blocking" as const,
            options: ["Merge it as it is (recommended)", "Leave it open"],
            askedAt: new Date().toISOString(),
          },
        ],
      }),
    );
  },
  /** A re-plan waits to be accepted: the tray holds Review diff, Keep planning, Accept plan */
  "loop-replan": ({ store }) => {
    loopScene(store, (loop) => ({
      ...loop,
      status: "awaiting_plan",
      replanReason:
        "Item 2 failed twice: the test runner is not installed, so the plan adds an install step first.",
    }));
  },
  /** An item failed and its repair re-plan runs: the red state */
  "loop-failed": ({ store }) => {
    loopScene(
      store,
      (loop) => ({
        ...loop,
        status: "replanning",
        waitingSince: undefined,
        items: loop.items.map((i) =>
          i.id === "2" ? { ...i, status: "failed" as const } : i,
        ),
        current: {
          kind: "replan",
          itemId: "2",
          historyIndex: 0,
          startedAt: new Date().toISOString(),
        },
      }),
      true,
    );
  },
  /** Every item done: Close replaces Stop */
  "loop-finished": ({ store }) => {
    loopScene(store, (loop) =>
      stopLoop(
        {
          ...loop,
          items: loop.items.map((i) => ({ ...i, status: "done" as const })),
        },
        "done",
        "Every item is done.",
      ),
    );
  },
  /** The person stopped the loop: Resume and Close */
  "loop-stopped": ({ store }) => {
    loopScene(store, (loop) =>
      stopLoop(loop, "stopped", "You stopped the loop."),
    );
  },
  /** The gear opened: strategy, Parallel and the note */
  "loop-settings-open": async ({ store }) => {
    loopScene(
      store,
      (loop) => ({
        ...loop,
        status: "running",
        waitingSince: undefined,
      }),
      true,
    );
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector(
        "[data-testid=loop-settings-toggle]",
      ) as HTMLElement
    )?.click();
  },
  /** Loop mode at IDGAF with seven refused calls: the one-line chip and the blocked badge */
  "loop-idgaf": ({ store }) => {
    store.dispatch(newSession(session([], "Fix parseConfig")));
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loopState()));
    for (const area of POLICY_AREAS) {
      store.dispatch(setPolicyLevel({ area, level: "idgaf" }));
    }
    for (let i = 0; i < 7; i++) {
      store.dispatch(
        addBlockedCall({
          id: String(i),
          toolName: "run_terminal_command",
          summary: `rm -rf build-${i}`,
          source: i % 2 ? "auto" : "deny-rule",
          reason: "Deletes files outside the task",
          parsedArgs: { command: `rm -rf build-${i}` },
          at: NOW.getTime(),
        } as never),
      );
    }
  },
  /** The same, with the blocked list open above the mode bar */
  "loop-blocked-open": async (ctx) => {
    await (FIXTURES as Record<string, Fixture>)["loop-idgaf"](ctx);
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector(
        "[data-testid=recently-blocked-toggle]",
      ) as HTMLElement
    )?.click();
  },
  "permissions-editor": permissionsEditor,
  /** The Settings page, Tools tab, from the top: built-in tools, then MCP servers */
  "settings-tools": async (ctx) => {
    addMcpServer(ctx);
    ctx.navigate("/config?tab=tools");
    await new Promise((r) => setTimeout(r, 500));
  },
  /** Settings, MCP servers, at a server with its tools listed (the list lived on the Tools tab before) */
  "settings-tools-mcp": async (ctx) => {
    addMcpServer(ctx);
    (ctx.messenger.responses as any)["mcp/scopes"] = mcpScopes();
    (ctx.messenger.responses as any)["mcp/list"] = {
      servers: [
        {
          name: "github",
          scope: "user",
          file: MCP_USER_FILE,
          transport: "stdio",
          target: "github-mcp-server",
          secrets: [],
          envNames: [],
          headerNames: [],
        },
      ],
      problems: [],
    };
    ctx.navigate("/config?tab=mcp");
    await new Promise((r) => setTimeout(r, 500));
    const server = document.querySelector("[data-testid=mcp-server-github]");
    (
      server?.querySelector("[data-testid=tool-group-header]") as HTMLElement
    )?.click();
    // after the list has opened
    await new Promise((r) => setTimeout(r, 200));
    server?.scrollIntoView({ block: "start" });
  },
  /** Where `npm run walk` starts: the chat page, the same MCP server, and the walk's answers (walkMock.ts) */
  "walk-start": (ctx) => {
    installWalkMock(ctx);
    addMcpServer(ctx);
  },
};

/** One connected MCP server whose tools differ: Automatic, Ask First, Excluded, and one waiting for approval. */
function addMcpServer({ store, messenger }: FixtureContext): void {
  const tool = (name: string, description: string, extra: object = {}) => ({
    type: "function",
    function: { name: `github_${name}`, description },
    displayTitle: name,
    originalFunctionName: name,
    group: "github",
    readonly: false,
    ...extra,
  });
  const info: any = structuredClone(
    messenger.responses["config/getSerializedProfileInfo"],
  );
  info.result.config.mcpServerStatuses = [
    {
      id: "github",
      name: "github",
      type: "stdio",
      command: "github-mcp-server",
      status: "connected",
      errors: [],
      infos: [],
      prompts: [],
      resources: [],
      resourceTemplates: [],
      tools: [],
    },
  ];
  info.result.config.tools = [
    tool("list_issues", "List the issues of a repository, newest first."),
    tool("get_pull_request", "Read one pull request with its reviews."),
    tool("create_issue", "Open an issue in a repository."),
    tool("delete_repository", "Delete a repository and everything in it."),
    tool("search_code", "Search code across repositories.", {
      mcpPendingApproval: "added",
    }),
  ];
  messenger.responses["config/getSerializedProfileInfo"] = info;
  sendConfig(messenger);
  store.dispatch(
    setToolPolicy({
      toolName: "github_list_issues",
      policy: "allowedWithoutPermission",
    }),
  );
  store.dispatch(
    setToolPolicy({ toolName: "github_delete_repository", policy: "disabled" }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function subCall(id: string): ToolCallState {
  return {
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "subagent", arguments: "{}" },
    },
    status: "calling",
    parsedArgs: {},
    subagent: {
      agent: "explore",
      model: "Claude Haiku",
      description: "Find where timeouts are parsed",
      prompt: "find it",
      status: "running",
      toolCalls: [],
      text: "",
      startedAt: Date.now() - 95_000,
      usage: { inputTokens: 12_400, outputTokens: 900 },
    },
  } as ToolCallState;
}

/** Subagent calls with the given statuses (and names) on one assistant turn. */
function agentsSession(
  runs: { agent?: string; status: string; model?: string }[],
): Fixture {
  return ({ store }) => {
    const calls = runs.map((r, i) => {
      const c: any = subCall(`s${i + 1}`);
      c.subagent = {
        ...c.subagent,
        agent: r.agent ?? c.subagent.agent,
        status: r.status,
        ...(r.model ? { model: r.model } : {}),
        ...(r.status === "running" ? {} : { endedAt: Date.now() - 1000 }),
      };
      return c as ToolCallState;
    });
    store.dispatch(
      newSession(
        session([
          user("Look into the timeouts in three places"),
          assistant("I started some helpers.", calls),
        ]),
      ),
    );
  };
}

/** Three provider connections, two accounts in providers.yaml and a pulled model list. */
function seedModelConnections(ctx: FixtureContext): void {
  Object.assign(ctx.messenger.responses, {
    "config/getProviderSetup": {
      connections: [
        {
          provider: "anthropic",
          connection: {},
          account: "anthropic-work",
          models: [
            { name: "Claude Opus", model: "claude-opus-4-5" },
            { name: "Claude Sonnet", model: "claude-sonnet-4-5" },
          ],
          key: {
            state: "secret",
            secretName: "CONTINUOUS_ANTHROPIC_API_KEY",
            storedIn: { secure: true, env: false },
          },
        },
        {
          provider: "bedrock",
          connection: { region: "us-east-1", profile: "work" },
          models: [
            { name: "Bedrock Opus", model: "anthropic.claude-opus-4-5" },
          ],
          key: { state: "none" },
        },
        {
          provider: "openai",
          connection: { apiBase: "http://localhost:1234/v1" },
          models: [{ name: "Local", model: "qwen3-coder-30b-a3b-instruct" }],
          key: {
            state: "secret",
            secretName: "LOCAL_KEY",
            storedIn: { secure: false, env: false },
          },
        },
      ],
      secureStorageAvailable: true,
      preferredKeyStorage: "secure",
      editable: true,
    },
    "providers/list": {
      instances: [
        {
          name: "anthropic-work",
          provider: "anthropic",
          source: "global",
          sourceUri: "file:///home/u/.continuous/providers.yaml",
          key: {
            state: "secret",
            secretName: "CONTINUOUS_ANTHROPIC_API_KEY",
            storedIn: { secure: true, env: false },
          },
          usedBy: [{ config: "Main Config", model: "Claude Sonnet" }],
        },
        {
          name: "strata",
          provider: "openai",
          apiBase: "https://strata.example/v1",
          source: "global",
          sourceUri: "file:///home/u/.continuous/providers.yaml",
          key: { state: "none" },
          usedBy: [],
        },
      ],
      globalFileUri: "file:///home/u/.continuous/providers.yaml",
      secureStorageAvailable: true,
    },
    "modelCatalog/status": {
      policy: "automatic",
      refreshHours: 24,
      openrouter: { fetchedAt: "2026-11-09T08:30:00.000Z", count: 312 },
    },
  });
}

/** A Settings tab; `tab` may carry more of the query ("permissions&view=rules"). */
function settingsTab(tab: string): Fixture {
  return async ({ navigate }) => {
    navigate(`/config?tab=${tab}`);
    await sleep(600);
  };
}

/** Permissions with the first-run card dismissed, so the view itself is at the top. */
function permissionsView(query: string): Fixture {
  return async (ctx) => {
    // The page reads the rules in every view (Custom policy needs them)
    ctx.messenger.responseHandlers["policy/rules"] = (async () =>
      permissionsReport()) as never;
    await settingsTab(`permissions&${query}`)(ctx);
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid=permissions-intro-dismiss]",
      )
      ?.click();
    await sleep(300);
  };
}

const BEDROCK_MODELS = [
  {
    id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5",
    provider: "Anthropic",
    kind: "on-demand",
    needsAnthropicUseCase: true,
  },
  {
    id: "us.amazon.nova-pro-v1:0",
    name: "Nova Pro",
    provider: "Amazon",
    kind: "inference-profile",
    access: "needs-access",
  },
];

/** The Bedrock "Test connection" result, mounted on its own (see main.tsx). */
function bedrock(ok: boolean): Fixture {
  return async ({ messenger }) => {
    const h = messenger.responseHandlers as any;
    h["bedrock/listModels"] = async (d: any) =>
      !ok
        ? {
            ok: false,
            error:
              "AccessDeniedException: User arn:aws:sts::123456789012:assumed-role/dev-role-for-the-production-account/session-1731234567 is not authorized to perform: bedrock:ListFoundationModels",
          }
        : d.endpoint === "mantle"
          ? { ok: true, models: [] }
          : { ok: true, models: BEDROCK_MODELS };
    h["bedrock/probeToolCalls"] = async () => ({
      ok: true,
      kind: "text",
      label: "Tool calls: written as text (qwen-xml)",
      preset: "qwen-xml (tools written as text)",
    });
    await sleep(300);
    [...document.querySelectorAll("button")]
      .find((b) => /Test connection/.test(b.textContent ?? ""))
      ?.click();
    await sleep(600);
  };
}

/** OpenRouter provider setup with the one-time "Pull model information" card. */
function catalogue(): Fixture {
  return async ({ messenger }) => {
    const h = messenger.responseHandlers as any;
    h["modelCatalog/status"] = async () => ({
      policy: "ask",
      refreshHours: 24,
    });
    h["modelCatalog/cached"] = async () => null;
    await sleep(400);
  };
}

// The loop frame is mounted on its own (see main.tsx, LoopFrameDemo); the state is in the name.
const noop: Fixture = async () => {};

Object.assign(FIXTURES, {
  catalogue: catalogue(),
  "loop-frame-running": noop,
  "loop-frame-waiting": noop,
  "loop-frame-failed": noop,
  "loop-frame-finished": noop,
  "loop-frame-stopped": noop,
  "settings-models": settingsTab("models"),
  /** Models with three provider connections, two accounts and a pulled model list */
  "settings-models-connections": async (ctx) => {
    seedModelConnections(ctx);
    await settingsTab("models")(ctx);
  },
  /** The same page with the Accounts fold opened by its link */
  "settings-models-accounts": async (ctx) => {
    seedModelConnections(ctx);
    await settingsTab("models&section=accounts")(ctx);
  },
  "settings-rules": settingsTab("rules"),
  "settings-permissions": async (ctx) => {
    ctx.messenger.responseHandlers["policy/rules"] = (async () =>
      listEffectiveRules({
        levels: DEFAULT_POLICY_LEVELS,
        floor: ["runTerminalCommand(rm -rf /*)"],
        user: {
          deny: ["runTerminalCommand(terraform apply*)"],
          ask: ["runTerminalCommand(git push*)"],
          allow: ["runTerminalCommand(npm test*)", "readFile(src/**)"],
        },
        assistant: { allow: ["mcp__github__*"] },
        folder: [],
        cliFile: { exclude: ["Write(.git/**)"] },
        maxNewPlanItems: 3,
        notices: [],
      } as never)) as never;
    await settingsTab("permissions&view=rules")(ctx);
  },
  "permissions-levels": permissionsView("view=levels"),
  "permissions-protections": permissionsView("view=protections"),
  "permissions-protections-open": permissionsView(
    "view=protections&section=commands-secrets",
  ),
  "settings-configs": settingsTab("configs"),
  // The old Indexing link: General, with "Codebase index and docs" opened by it
  "settings-general-index": settingsTab("indexing"),
  "settings-general": settingsTab("general"),
  "settings-help": settingsTab("help"),
  "agents-running": agentsSession([
    { status: "running" },
    {
      agent: "a-reviewer-with-an-extremely-long-agent-name",
      status: "running",
      model:
        "Claude Opus 4 with a very long model title (eu-west-1 inference profile)",
    },
    { status: "completed" },
  ]),
  "agents-ended": agentsSession([
    {
      agent: "a-reviewer-with-an-extremely-long-agent-name",
      status: "completed",
    },
    { status: "interrupted" },
    { status: "cancelled" },
  ]),
  "bedrock-ok": bedrock(true),
  "bedrock-fail": bedrock(false),
});

const permissionsReport = () =>
  listEffectiveRules({
    levels: DEFAULT_POLICY_LEVELS,
    floor: ["runTerminalCommand(rm -rf /*)"],
    user: { ask: ["runTerminalCommand(git push*)"] },
    maxNewPlanItems: 3,
  } as never);

Object.assign(FIXTURES, {
  /** The rules are still being read: the skeleton, then the slow line */
  "permissions-loading": async (ctx: FixtureContext) => {
    ctx.messenger.responseHandlers["policy/rules"] = (() =>
      new Promise(() => {})) as never;
    await settingsTab("permissions&view=rules")(ctx);
    await sleep(4500);
  },
  /** The read failed: an error that names the files, with Retry */
  "permissions-error": async (ctx: FixtureContext) => {
    ctx.messenger.responseHandlers["policy/rules"] = (async () => {
      throw new Error("unreadable");
    }) as never;
    await settingsTab("permissions&view=rules")(ctx);
  },
  /** The first-run overview card on the Permissions page */
  "permissions-intro": async (ctx: FixtureContext) => {
    ctx.messenger.responseHandlers["policy/rules"] = (async () =>
      permissionsReport()) as never;
    await settingsTab("permissions")(ctx);
  },
  /** An empty chat with the one-line first-run notice (flag not set) */
  "chat-first-run": ({ store }: FixtureContext) => {
    store.dispatch(newSession());
  },
});

/** What core's search of this computer answers: Ollama and LM Studio, one model id long. */
const FOUND_SERVERS = [
  {
    title: "Ollama",
    apiBase: "http://127.0.0.1:11434/v1/",
    models: [
      {
        name: "llama3.1:8b",
        modelId: "llama3.1:8b",
        contextLength: 131072,
        supportsTools: true,
      },
      { name: "qwen3:8b", modelId: "qwen3:8b" },
    ],
  },
  {
    title: "LM Studio",
    apiBase: "http://127.0.0.1:1234/v1/",
    models: [
      {
        name: "lmstudio-community/Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q4_k_m.gguf",
        modelId:
          "lmstudio-community/Qwen2.5-Coder-32B-Instruct-GGUF/qwen2.5-coder-32b-instruct-q4_k_m.gguf",
        contextLength: 32768,
      },
    ],
  },
];

/** What the search of this computer answers, for the start screen. */
function foundServers(messenger: MockIdeMessenger, servers: unknown[]): void {
  (messenger.responses as any)["models/detectLocal"] = servers;
}

/** The onboarding card on its start screen, after `servers` were found. */
function onboardingStart(
  servers: unknown[],
  steps: (ctx: FixtureContext) => Promise<void> | void = () => {},
): Fixture {
  return async (ctx) => {
    foundServers(ctx.messenger, servers);
    ctx.store.dispatch(setOnboardingCard({ show: true }));
    await sleep(700);
    await steps(ctx);
  };
}

/** "Add a model" in the app dialog, from its start screen. */
function addModelDialog(
  servers: unknown[],
  steps: (ctx: FixtureContext) => Promise<void> | void = () => {},
): Fixture {
  return async (ctx) => {
    foundServers(ctx.messenger, servers);
    ctx.store.dispatch(newSession());
    ctx.store.dispatch(setShowDialog(true));
    ctx.store.dispatch(
      setDialogMessage(
        createElement(ProviderSetupFlow, {
          onDone: () => {},
          onCancel: () => {},
        }),
      ),
    );
    await sleep(600);
    await steps(ctx);
  };
}

const clickButton = (name: string) => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent?.trim() === name)
    ?.click();
};

const clickTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();

Object.assign(FIXTURES, {
  /** Onboarding, "Nothing yet": Ollama running with the suggested model, and the key links */
  "onboarding-local": onboardingStart([FOUND_SERVERS[0]], async () => {
    clickTestId("door-nothing");
    await sleep(400);
  }),
  /** Onboarding, the start screen with two servers found on this computer */
  "onboarding-local-chooser": onboardingStart(FOUND_SERVERS),
  /** Onboarding, "A server on my network": the connection step with More open */
  "onboarding-local-server": onboardingStart([], async () => {
    clickTestId("door-network");
    await sleep(400);
    document
      .querySelector<HTMLDetailsElement>('[data-testid="connection-more"]')
      ?.setAttribute("open", "");
    await sleep(300);
  }),
  /** "Add a model" in the dialog: what do you have, with two servers found */
  "setup-start-found": addModelDialog(FOUND_SERVERS),
  /** The same with nothing answering on this computer */
  "setup-start-none": addModelDialog([]),
  /** The models step of a found server: the three columns, one long model id */
  "setup-models-local": addModelDialog(FOUND_SERVERS, async () => {
    clickTestId("found-1234");
    await sleep(500);
  }),
  /** "Use for": what the new model is used for, and what each role uses now */
  "setup-use-for": addModelDialog(FOUND_SERVERS, async () => {
    clickTestId("found-11434");
    await sleep(500);
    clickButton("Next");
    await sleep(400);
  }),
  /** The connection step after a test that got no answer from a local server */
  "setup-test-failed": async (ctx: FixtureContext) => {
    (ctx.messenger.responses as any)["openaiCompat/testConnection"] = {
      ok: false,
      error: "Could not reach http://127.0.0.1:8080/v1/models: fetch failed.",
    };
    await addModelDialog([])(ctx);
    clickTestId("door-this-computer");
    await sleep(400);
    clickButton("Test connection");
    await sleep(500);
  },
});

Object.assign(FIXTURES, AUDIT_FIXTURES);

/** A drag event as Chromium builds it, with VS Code's types set. */
function dispatchDrag(type: string, data: Record<string, string>) {
  const target = document.querySelector(
    "[data-testid=editor-input-main]",
  ) as HTMLElement | null;
  if (!target) return;
  const dataTransfer = new DataTransfer();
  for (const [k, v] of Object.entries(data)) dataTransfer.setData(k, v);
  target.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
  );
}

const WORKSPACE = "file:///Users/user/workspace1";

Object.assign(FIXTURES, {
  /** A file dragged over the input (not yet dropped): the drop target */
  "drop-target": async ({ store }: FixtureContext) => {
    store.dispatch(newSession());
    await sleep(800);
    dispatchDrag("dragenter", {
      "application/vnd.code.uri-list": `${WORKSPACE}/src/app.ts`,
    });
    await sleep(200);
  },
  /** A drop of .env and a file outside the workspace: the refusal note */
  "drop-refused": async ({ store }: FixtureContext) => {
    store.dispatch(newSession());
    await sleep(800);
    const uris = [`${WORKSPACE}/.env`, "file:///tmp/elsewhere/notes.md"];
    dispatchDrag("drop", {
      ResourceURLs: JSON.stringify(uris),
      "application/vnd.code.uri-list": uris.join("\r\n"),
    });
    await sleep(400);
  },
  /** Files dropped from the operating system: a snapshot chip, and a binary refused */
  "drop-snapshot": async ({ store }: FixtureContext) => {
    store.dispatch(newSession());
    await sleep(800);
    const target = document.querySelector(
      "[data-testid=editor-input-main]",
    ) as HTMLElement | null;
    if (!target) return;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["# Release checklist\n\n- tag\n- notes\n"], "checklist.md", {
        type: "text/markdown",
      }),
    );
    dataTransfer.items.add(
      new File([new Uint8Array([0x4d, 0x5a, 0, 0, 1, 2])], "setup.exe", {
        type: "application/octet-stream",
      }),
    );
    target.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
    );
    await sleep(600);
  },
});

/** Model ids as long as the ones routers and Bedrock give, with no place to break. */
const LONG_MODELS = [
  {
    name: "accounts/fireworks/models/llama-v3p3-70b-instruct-long-context-preview",
    model:
      "accounts/fireworks/models/llama-v3p3-70b-instruct-long-context-preview",
  },
  {
    name: "Claude Sonnet 4.5 (cross-region inference profile, eu-west-1)",
    model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
];

const HOUR = 3_600_000;
// Ages from the real clock, so the Today and older groups hold the same rows on every run
const SESSIONS = [
  ["Fix the failing parseConfig test", 1],
  [
    "Why does extensions/vscode/src/autocomplete/completionProvider.ts debounce twice when the document changes",
    3,
  ],
  [
    "refactor_the_whole_authentication_middleware_without_spaces_in_the_title",
    30,
  ],
  ["Release notes for 2.22", 24 * 9],
  [
    "A question about context windows and how the meter counts tool output",
    24 * 45,
  ],
].map(([title, hoursAgo], i) => ({
  sessionId: `fixture-history-${i}`,
  title: title as string,
  dateCreated: String(Date.now() - (hoursAgo as number) * HOUR),
  workspaceDirectory: "file:///Users/user/workspace1",
  messageCount: 4 + i * 7,
}));

/** What core answers about the configured connections: one, with LONG_MODELS and a stored key. */
function longModelSetup(provider: string) {
  return {
    connections: [
      {
        provider,
        connection: {},
        models: LONG_MODELS,
        key: { state: "secret", secretName: "FIXTURE_API_KEY" },
      },
    ],
    secureStorageAvailable: true,
    preferredKeyStorage: "secure",
    editable: true,
  };
}

Object.assign(FIXTURES, {
  /**
   * The setup form where issue 982 was: the onboarding card's API key tab, a
   * centred flex row, at the model list, with two configured models whose ids
   * are long. A flex item is as wide as its longest row unless it may shrink.
   */
  "setup-long-model": async ({ store, messenger }: FixtureContext) => {
    (messenger.responses as any)["config/getProviderSetup"] =
      longModelSetup("anthropic");
    store.dispatch(setOnboardingCard({ show: true }));
    await sleep(700);
    clickTestId("door-api-key");
    await sleep(400);
    // the key is already stored, so the first step has nothing to ask for
    clickButton("Next");
    await sleep(500);
  },
  /** The same list in the app dialog, as "Manage models" opens it on a connection */
  "setup-dialog": async ({ store, messenger }: FixtureContext) => {
    (messenger.responses as any)["config/getProviderSetup"] =
      longModelSetup("together");
    store.dispatch(newSession());
    store.dispatch(setShowDialog(true));
    store.dispatch(
      setDialogMessage(
        createElement(ProviderSetupFlow, {
          initialProvider: "together",
          initialConnection: {},
          initialStep: "models",
          onDone: () => {},
          onCancel: () => {},
        }),
      ),
    );
    await sleep(600);
  },
  /** History with sessions from today to last month, and its search box */
  history: async ({ store, messenger, navigate }: FixtureContext) => {
    (messenger.responses as any)["history/list"] = SESSIONS;
    store.dispatch(setAllSessionMetadata(SESSIONS));
    navigate("/history");
    await sleep(600);
  },
  /**
   * A reply whose render throws, so the error boundary round the message
   * draws the error, its stack and Restart. The reply's reasoning text is a
   * number: only the message body reads it, and it calls a string method on it.
   */
  "message-error": ({ store }: FixtureContext) => {
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          {
            ...assistant(MARKDOWN_REPLY),
            reasoning: { text: 5 as never, startAt: 0, endAt: 1 },
          },
        ]),
      ),
    );
  },
  /** A reply at 62% context: the compact button in the row under it gets its words */
  "context-60": ({ store }: FixtureContext) => {
    statusRowScene(store);
    store.dispatch(setContextPercentage(0.62));
  },
  /**
   * A reasoning model with a long name and a thinking level set for the mode,
   * so the Thinking menu and the model name share the left of the input row.
   */
  "thinking-menu": async ({ store, messenger }: FixtureContext) => {
    const model = {
      ...CHAT_MODEL,
      title: "Claude Sonnet 4.5 (Bedrock, eu-west-1)",
    };
    const info: any = structuredClone(
      messenger.responses["config/getSerializedProfileInfo"],
    );
    const config = info.result.config;
    config.modelsByRole.chat = [model];
    config.selectedModelByRole.chat = model;
    const mode = store.getState().session.mode;
    config.modeModels = {
      [mode]: { title: model.title, reasoningEffort: "medium" },
    };
    messenger.mockMessageToWebview("configUpdate", info);
    statusRowScene(store);
    await sleep(300);
  },
  /** A prompt of forty lines: the input stops growing and scrolls inside itself */
  "long-prompt": async ({ store }: FixtureContext) => {
    store.dispatch(newSession());
    await sleep(600);
    store.dispatch(
      setMainEditorContentTrigger({
        type: "doc",
        content: Array.from({ length: 40 }, (_, i) => ({
          type: "paragraph",
          content: [
            {
              type: "text",
              text:
                i % 8 === 3
                  ? "gui/src/components/mainInput/TipTapEditor/utils/resolveEditorContent.ts:214"
                  : `Step ${i + 1}: read the failing test, then change only what it needs.`,
            },
          ],
        })),
      }),
    );
    await sleep(400);
  },
});

/** A provider account as providers.yaml has it, key by reference. */
const WORK_ACCOUNT = {
  name: "anthropic-work",
  provider: "anthropic",
  apiKey: "${{ secrets.ANTHROPIC_WORK_KEY }}",
  requestOptions: { timeout: 300 },
};

const NO_CREDENTIALS = {
  apiKey: { state: "none" as const },
  headers: {},
  env: {},
};

/**
 * "Configure" for one model, in the app dialog: the model as the config
 * loaded it, the entry the dialog reads (`config/getModelBlock`), and what
 * its server lists when asked.
 */
async function modelConfigScene(
  { store, messenger }: FixtureContext,
  scene: {
    model: Partial<ModelDescription> & { title: string };
    block: Record<string, unknown>;
    tab?: ModelConfigTab;
  },
): Promise<void> {
  const model = scene.model as ModelDescription;
  const info: any = structuredClone(
    messenger.responses["config/getSerializedProfileInfo"],
  );
  info.result.config.modelsByRole.chat = [model];
  info.result.config.selectedModelByRole.chat = model;
  messenger.mockMessageToWebview("configUpdate", info);
  Object.assign(messenger.responses as any, {
    "config/getModelBlock": {
      editable: true,
      file: "C:\\Users\\dev\\.continuous\\config.yaml",
      scope: "user",
      credentials: NO_CREDENTIALS,
      entryYaml: "",
      ...scene.block,
    },
    "models/listedLimits": { ok: true },
  });
  store.dispatch(newSession());
  store.dispatch(setShowDialog(true));
  store.dispatch(
    setDialogMessage(
      createElement(ModelConfigDialog, {
        title: model.title,
        onDone: () => {},
        onCancel: () => {},
        onOpenFile: () => {},
        ...(scene.tab ? { initialTab: scene.tab } : {}),
      }),
    ),
  );
  await sleep(600);
}

const CLOUD_MODEL = {
  title: "Claude Sonnet",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  model: "claude-sonnet-4-6",
  apiBase: "https://api.anthropic.com/v1/",
  contextLength: 200_000,
  contextLengthSource: "published" as const,
  // The loader fills in the provider's own limit (core/config/yaml/models.ts)
  completionOptions: { model: "claude-sonnet-4-6", maxTokens: 8192 },
  maxTokensSource: "config" as const,
  roles: ["chat", "edit"],
};

const CLOUD_BLOCK = {
  entry: {
    name: "Claude Sonnet",
    connection: "anthropic-work",
    model: "claude-sonnet-4-6",
    roles: ["chat", "edit"],
  },
  layers: {
    account: WORK_ACCOUNT,
    accountFile: "file:///c%3A/Users/dev/.continuous/providers.yaml",
  },
};

Object.assign(FIXTURES, {
  /** A cloud model through an account: a role the person set, a timeout from the account */
  "model-overview-cloud": (ctx: FixtureContext) =>
    modelConfigScene(ctx, { model: CLOUD_MODEL, block: CLOUD_BLOCK }),
  /** A catalog model's variant: values from the catalog model, the variant and the account */
  "model-overview-catalog": (ctx: FixtureContext) =>
    modelConfigScene(ctx, {
      model: {
        ...CLOUD_MODEL,
        title: "Claude Sonnet#plan",
        contextLengthSource: "config",
        completionOptions: {
          model: "claude-sonnet-4-6",
          maxTokens: 32_000,
          temperature: 0.6,
          reasoning: true,
          reasoningBudgetTokens: 8000,
        },
      },
      block: {
        catalog: true,
        entry: { from: "Claude Sonnet#plan", roles: ["chat"] },
        layers: {
          ...CLOUD_BLOCK.layers,
          catalogModel: {
            name: "Claude Sonnet",
            connection: "anthropic-work",
            model: "claude-sonnet-4-6",
            contextLength: 200_000,
            defaultCompletionOptions: { temperature: 0.6, maxTokens: 32_000 },
            variants: {
              plan: {
                defaultCompletionOptions: {
                  reasoning: true,
                  reasoningBudgetTokens: 8000,
                },
              },
            },
          },
          catalogFile: "file:///c%3A/Users/dev/.continuous/models.yaml",
        },
      },
    }),
  /** A local Ollama model whose server reported its window */
  "model-overview-ollama": (ctx: FixtureContext) =>
    modelConfigScene(ctx, {
      model: {
        title: "Qwen3 Coder (Ollama)",
        provider: "ollama",
        underlyingProviderName: "ollama",
        model: "qwen3-coder:30b",
        apiBase: "http://localhost:11434/",
        contextLength: 262_144,
        contextLengthSource: "provider",
        completionOptions: { model: "qwen3-coder:30b", maxTokens: 4096 },
        maxTokensSource: "fallback",
      },
      block: {
        entry: {
          name: "Qwen3 Coder (Ollama)",
          provider: "ollama",
          model: "qwen3-coder:30b",
        },
      },
    }),
  /** A local OpenAI-compatible server that reports no window: 32,768 is assumed */
  "model-overview-assumed": (ctx: FixtureContext) =>
    modelConfigScene(ctx, {
      model: {
        title: "Local llama.cpp",
        provider: "openai",
        underlyingProviderName: "openai",
        model: "my-finetune-q5",
        apiBase: "http://127.0.0.1:8080/v1/",
        contextLength: 32_768,
        contextLengthSource: "unknown",
        completionOptions: { model: "my-finetune-q5" },
        maxTokensSource: "none",
      },
      block: {
        entry: {
          name: "Local llama.cpp",
          provider: "openai",
          model: "my-finetune-q5",
          apiBase: "http://127.0.0.1:8080/v1",
        },
      },
    }),
  /** The Generation tab: one value the person set, the rest saying what not set does */
  "model-config-generation": (ctx: FixtureContext) =>
    modelConfigScene(ctx, {
      model: {
        ...CLOUD_MODEL,
        completionOptions: {
          model: "claude-sonnet-4-6",
          maxTokens: 8192,
          temperature: 0.2,
        },
      },
      block: {
        ...CLOUD_BLOCK,
        entry: {
          ...CLOUD_BLOCK.entry,
          defaultCompletionOptions: { temperature: 0.2 },
        },
      },
      tab: "generation",
    }),
});

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** A reply that reported usage, with the prompt cache warm. */
/**
 * A conversation whose context has something in every common part: an
 * attached file, a file read, a test run and the replies, with a reported
 * count close to what they hold, so the split is the one a person would see.
 */
function contextScene(store: Store): void {
  const line = (
    n: number,
  ) => `export const value${n} = compute(${n}); // a line of code
`;
  const file = (lines: number) =>
    Array.from({ length: lines }, (_, i) => line(i)).join("");
  const readCall = {
    id: "call-read",
    type: "function" as const,
    function: {
      name: "read_file",
      arguments: JSON.stringify({ filepath: "src/config/parseConfig.ts" }),
    },
  };
  const ask: ChatHistoryItem = {
    message: { role: "user", content: "Why does the parseConfig test fail?" },
    contextItems: [
      {
        id: { providerTitle: "file", itemId: "readme" },
        name: "README.md",
        description: "README.md",
        content: file(220),
      },
    ],
  };
  const read: ChatHistoryItem = {
    message: { role: "assistant", content: "", toolCalls: [readCall] },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: readCall.id,
        toolCall: readCall,
        status: "done",
        parsedArgs: { filepath: "src/config/parseConfig.ts" },
        output: [
          {
            name: "parseConfig.ts",
            description: "src/config/parseConfig.ts",
            content: file(700),
          },
        ],
      } as ToolCallState,
    ],
  };
  store.dispatch(
    newSession(
      session([
        ask,
        read,
        assistant("Running the test to confirm.", [runCommandCall("done")]),
        assistant(MARKDOWN_REPLY),
      ]),
    ),
  );
  store.dispatch(
    addRequestUsageToSession({
      provider: CHAT_MODEL.provider,
      model: CHAT_MODEL.model,
      usage: { promptTokens: 15_000, completionTokens: 400 },
    }),
  );
  store.dispatch(
    setPromptCacheState({
      escalated: false,
      lastRequestAt: Date.now() - 60_000,
      lastTtl: "5m",
      lastInputTokens: 15_000,
    }),
  );
}

function statusRowScene(store: Store): void {
  store.dispatch(
    newSession(
      session([
        user("Why does the parseConfig test fail?"),
        assistant(MARKDOWN_REPLY),
      ]),
    ),
  );
  store.dispatch(
    addRequestUsageToSession({
      provider: CHAT_MODEL.provider,
      model: CHAT_MODEL.model,
      usage: { promptTokens: 84_000, completionTokens: 1_200 },
    }),
  );
  store.dispatch(
    setPromptCacheState({
      escalated: false,
      lastRequestAt: Date.now() - 60_000,
      lastTtl: "5m",
      lastInputTokens: 84_000,
    }),
  );
}

// ---- Settings, MCP servers, and the Add / Edit dialog ----

const MCP_USER_FILE = String.raw`C:\Users\dev\.continuous\config.yaml`;
const MCP_FOLDER = String.raw`D:\code\shop-frontend`;
const MCP_FOLDER_DIR = String.raw`D:\code\shop-frontend\.continuous\mcpServers`;

function mcpScopes(trust: "trusted" | "untrusted" | "none" = "trusted") {
  return {
    user: { file: MCP_USER_FILE, exists: true },
    folders: [
      {
        dir: MCP_FOLDER,
        name: "shop-frontend",
        mcpDir: MCP_FOLDER_DIR,
        trust,
      },
    ],
    secretStore: {
      kind: "secure",
      envFile: String.raw`C:\Users\dev\.continuous\.env`,
    },
    defaults: {
      connectionTimeoutMs: 20_000,
      probeTimeoutMs: 20_000,
      toolCallTimeoutMs: 60_000,
      inheritedEnv: [
        "PATH",
        "HOME",
        "USER",
        "USERPROFILE",
        "LOGNAME",
        "USERNAME",
      ],
      cwd: MCP_FOLDER,
    },
  };
}

/** Servers of both places, one that failed to start and one this page cannot write. */
function addMcpServersOfBothScopes(ctx: FixtureContext): void {
  addMcpServer(ctx);
  const { messenger } = ctx;
  const info: any = structuredClone(
    messenger.responses["config/getSerializedProfileInfo"],
  );
  const blank = {
    errors: [],
    infos: [],
    prompts: [],
    resources: [],
    resourceTemplates: [],
    tools: [],
  };
  info.result.config.mcpServerStatuses = [
    { ...info.result.config.mcpServerStatuses[0], configSource: "user" },
    {
      ...blank,
      id: "shop-database",
      name: "shop-database",
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-postgres", "--read-only"],
      status: "connected",
      configSource: "workspace",
      sourceFile: `${MCP_FOLDER_DIR}\\shop-database.yaml`,
    },
    {
      ...blank,
      id: "design-tokens",
      name: "design-tokens",
      type: "stdio",
      command: "npx",
      args: ["-y", "@acme/design-tokens-mcp"],
      status: "error",
      errors: [
        'Failed to connect to "design-tokens"\nError: command "npx" not found',
      ],
      configSource: "user",
    },
    {
      ...blank,
      id: "sentry",
      name: "sentry",
      url: "https://mcp.sentry.dev/mcp",
      status: "connected",
      configSource: "user",
      sourceFile: String.raw`C:\Users\dev\.continuous\mcpServers\claude_desktop_config.json`,
    },
  ];
  messenger.responses["config/getSerializedProfileInfo"] = info;
  sendConfig(messenger);
  const listing = (
    name: string,
    scope: "user" | "project",
    file: string,
    target: string,
  ) => ({
    name,
    scope,
    file,
    transport: "stdio",
    ...(scope === "project" ? { folder: MCP_FOLDER } : {}),
    target,
    secrets: [],
    envNames: [],
    headerNames: [],
  });
  (messenger.responses as any)["mcp/list"] = {
    servers: [
      listing("github", "user", MCP_USER_FILE, "github-mcp-server"),
      listing(
        "design-tokens",
        "user",
        MCP_USER_FILE,
        "npx -y @acme/design-tokens-mcp",
      ),
      listing(
        "shop-database",
        "project",
        `${MCP_FOLDER_DIR}\\shop-database.yaml`,
        "uvx mcp-server-postgres --read-only",
      ),
    ],
    problems: [],
  };
  (messenger.responses as any)["mcp/scopes"] = mcpScopes();
}

/** The Add dialog with a command server filled in, as after a paste. */
async function openMcpDialog(
  { store, messenger, navigate }: FixtureContext,
  mode: object = {
    kind: "add",
    prefillName: "filesystem",
    prefill: {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        String.raw`D:\code\shop-frontend\docs and notes`,
      ],
      env: [{ name: "GITHUB_TOKEN", value: "", secret: true }],
    },
  },
): Promise<void> {
  (messenger.responses as any)["mcp/list"] = { servers: [], problems: [] };
  (messenger.responses as any)["mcp/scopes"] = mcpScopes("none");
  (messenger.responses as any)["mcp/analyzeLaunch"] = {
    analysis: { findings: [], blocked: false, display: "" },
    expired: false,
  };
  navigate("/config?tab=mcp");
  await sleep(300);
  store.dispatch(setShowDialog(true));
  store.dispatch(
    setDialogMessage(
      createElement(McpServerDialog, {
        mode: mode as never,
        onDone: () => {},
        onCancel: () => {},
      }),
    ),
  );
  await sleep(300);
  // "For all my projects"
  (
    document.querySelector(
      "[data-testid=mcp-scope] input[type=radio]",
    ) as HTMLElement
  )?.click();
  await sleep(100);
}

const MCP_FIXTURES: Record<string, Fixture> = {
  /** Settings, MCP servers: servers of both places */
  "settings-mcp": async (ctx) => {
    addMcpServersOfBothScopes(ctx);
    ctx.navigate("/config?tab=mcp");
    await sleep(500);
  },
  /** The same with a folder whose servers are not trusted */
  "settings-mcp-untrusted": async (ctx) => {
    addMcpServersOfBothScopes(ctx);
    (ctx.messenger.responses as any)["mcp/scopes"] = mcpScopes("untrusted");
    ctx.navigate("/config?tab=mcp");
    await sleep(500);
  },
  /** Settings, MCP servers, with none */
  "settings-mcp-empty": async (ctx) => {
    (ctx.messenger.responses as any)["mcp/list"] = {
      servers: [],
      problems: [],
    };
    (ctx.messenger.responses as any)["mcp/scopes"] = mcpScopes("none");
    ctx.navigate("/config?tab=mcp");
    await sleep(500);
  },
  /** The Add dialog, basic part */
  "mcp-dialog": (ctx) => openMcpDialog(ctx),
  /** The Add dialog with Advanced open, scrolled to it */
  "mcp-dialog-advanced": async (ctx) => {
    await openMcpDialog(ctx);
    const toggle = document.querySelector(
      "[data-testid=mcp-server-dialog] button[aria-expanded]",
    ) as HTMLElement;
    toggle?.click();
    await sleep(150);
    toggle?.scrollIntoView({ block: "start" });
  },
  /** The Add dialog for a remote server, Advanced open */
  "mcp-dialog-url": async (ctx) => {
    await openMcpDialog(ctx, {
      kind: "add",
      prefillName: "linear",
      prefill: {
        name: "linear",
        transport: "http",
        autoTransport: true,
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "", secret: true }],
      },
    });
    const toggle = document.querySelector(
      "[data-testid=mcp-server-dialog] button[aria-expanded]",
    ) as HTMLElement;
    toggle?.click();
    await sleep(150);
    toggle?.scrollIntoView({ block: "start" });
  },
  /** The Add dialog after a Test that failed: the command was not found */
  "mcp-dialog-failed-test": async (ctx) => {
    (ctx.messenger.responses as any)["mcp/probe"] = {
      ran: true,
      result: {
        ok: false,
        status: "error",
        durationMs: 180,
        timeoutMs: 20_000,
        transport: "stdio",
        tools: [],
        resources: [],
        prompts: [],
        errors: ['Failed to connect to "filesystem"\nError: spawn npx ENOENT'],
        infos: [],
        stderr: { lines: [], truncated: false },
        hints: [
          {
            code: "install-node",
            text: "`npx` was not found. Install Node.js (it includes npx), then restart your editor so the PATH is refreshed.",
            link: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
          },
        ],
        needsSignIn: false,
        notice: "",
        pathSearched: [
          String.raw`C:\Windows\system32`,
          String.raw`C:\Windows`,
          String.raw`C:\Program Files\Git\cmd`,
        ],
      },
    };
    await openMcpDialog(ctx);
    (document.querySelector("[data-testid=mcp-test]") as HTMLElement)?.click();
    await sleep(200);
    (
      document.querySelector("[data-testid=mcp-confirm-run-yes]") as HTMLElement
    )?.click();
    await sleep(300);
    document
      .querySelector("[data-testid=mcp-test-result]")
      ?.scrollIntoView({ block: "end" });
  },
  /** The Add dialog asking before it runs the command */
  "mcp-dialog-confirm-run": async (ctx) => {
    await openMcpDialog(ctx);
    (document.querySelector("[data-testid=mcp-test]") as HTMLElement)?.click();
    await sleep(200);
  },
};
Object.assign(FIXTURES, MCP_FIXTURES);
