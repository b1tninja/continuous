import type {
  AssistantChatMessage,
  ChatMessage,
  LoopState,
  TaskPlan,
  Tool,
} from "../../..";
import {
  editFailureCauseOf,
  editFailureResult,
} from "../../../edit/editFailure";
import {
  executeFindAndReplace,
  executeMultiFindAndReplace,
} from "../../../edit/searchAndReplace/performReplace";
import { BuiltInToolNames } from "../../../tools/builtIn";
import { createNewFileTool } from "../../../tools/definitions/createNewFile";
import { grepSearchTool } from "../../../tools/definitions/grepSearch";
import {
  finishItemTool,
  holdQuestionTool,
} from "../../../tools/definitions/loopTools";
import { lsTool } from "../../../tools/definitions/ls";
import { multiEditTool } from "../../../tools/definitions/multiEdit";
import { readFileTool } from "../../../tools/definitions/readFile";
import { runTerminalCommandTool } from "../../../tools/definitions/runTerminalCommand";
import { singleFindAndReplaceTool } from "../../../tools/definitions/singleFindAndReplace";
import {
  resolveToolAlias,
  unknownToolResult,
} from "../../../tools/unknownTool";
import {
  approvalHeldResult,
  createLoop,
  holdQuestion,
  loopGrantKey,
  loopItemPrompt,
  LOOP_LIMITS,
} from "../../../util/loopMode";
import type { ScoredCall } from "./runner";
import { SEED } from "./scenarios";

/**
 * Cases for the guidance replay (guidanceReplay.ts): what does a model do
 * next after a tool call failed or was refused, and does the wording of that
 * result change it.
 *
 * A case is a conversation that stops at a call, a small project that call
 * was made against, and the call's result in several wordings ("arms"). The
 * replay sends the conversation once per arm and trial with that arm's text
 * as the result, and scores the next call against the project.
 *
 * The histories are written by hand from the shapes in
 * plans/research/agent-guidance-review-2026-11-21.md, section 4. No text from
 * a real session is in them.
 */
export interface GuidanceCase {
  id: string;
  /** The failure class. The report has one row per class and arm. */
  failureClass: string;
  /** One line for the report. */
  what: string;
  /**
   * The conversation after the system message. Its last message is the
   * assistant's call that failed; the replay adds the result.
   */
  messages: ChatMessage[];
  tools: Tool[];
  /** The files as they are when the result arrives, by workspace path. */
  project: Record<string, string>;
  /** The failed call's result by arm name. Every case of a class has the same arms. */
  arms: Record<string, string>;
  /**
   * Whether the next call does what the case needs, run against the project.
   * Only asked about a call that is valid (an offered tool, arguments that
   * fit its schema).
   */
  succeeded: (call: ScoredCall, project: Record<string, string>) => boolean;
  /** The next call of a model that read the result well; the oracle stub's answer. */
  oracle: AssistantChatMessage;
}

/** The call a case ends in: the one whose result the arms word. */
export function failedCallOf(c: GuidanceCase): {
  id: string;
  name: string;
  args: Record<string, unknown>;
} {
  const last = c.messages[c.messages.length - 1];
  const call = last?.role === "assistant" ? last.toolCalls?.[0] : undefined;
  if (!call?.function?.name) {
    throw new Error(`case ${c.id} does not end in a tool call`);
  }
  return {
    id: call.id ?? "failed",
    name: call.function.name,
    args: JSON.parse(call.function.arguments || "{}"),
  };
}

/**
 * The tail the IDE put on every failed call until 2026-11-22
 * (gui/src/redux/thunks/preprocessToolCallArgs.ts and callToolById.ts before
 * 89b176487). The `old` arms are written out here: they are history, so they
 * must not follow the code.
 */
const OLD_TAIL =
  "\n\nPlease try something else or request further instructions.";

/** The IDE's result for a call that failed in preprocessing, before e7a0b1a48. */
const oldInvalidArguments = (tool: string, message: string) =>
  `${tool} failed because the arguments were invalid, with the following message: ${message}${OLD_TAIL}`;

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistantCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", toolCallId: id, content };
}

const samePath = (given: unknown, path: string) =>
  String(given ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "") === path;

const readsFile = (call: ScoredCall, path: string) =>
  call.name === BuiltInToolNames.ReadFile && samePath(call.args.filepath, path);

const STRINGS_PATH = "src/strings.js";

// ---------------------------------------------------------------------------
// 1. IDE edit failure: the old text is not in the file
// ---------------------------------------------------------------------------

/**
 * src/strings.js after the person rewrote truncate, which the model has not
 * seen: its read (in the history) shows the seed's version.
 */
const STRINGS_AFTER_PERSON_EDIT = SEED[STRINGS_PATH].replace(
  /export function truncate[\s\S]*$/,
  `export function truncate(text, max, tail = "\\u2026") {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - tail.length)) + tail;
}
`,
);

const EDIT_ARGS = {
  filepath: STRINGS_PATH,
  old_string:
    '  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "\\u2026";',
  new_string:
    '  return s.length <= max ? s : s.slice(0, Math.max(0, max - 3)) + "...";',
};

/** Whether an edit call changes `path` when core's own search and replace runs it. */
function editApplies(
  call: ScoredCall,
  project: Record<string, string>,
  path: string,
): boolean {
  if (!samePath(call.args.filepath, path)) return false;
  const before = project[path];
  try {
    const after =
      call.name === BuiltInToolNames.MultiEdit
        ? executeMultiFindAndReplace(before, call.args.edits as any)
        : call.name === BuiltInToolNames.SingleFindAndReplace
          ? executeFindAndReplace(
              before,
              String(call.args.old_string),
              String(call.args.new_string),
              call.args.replace_all === true,
            )
          : before;
    return after !== before;
  } catch {
    return false;
  }
}

function editNotFoundCase(): GuidanceCase {
  const tool = BuiltInToolNames.SingleFindAndReplace;
  const project = { ...SEED, [STRINGS_PATH]: STRINGS_AFTER_PERSON_EDIT };
  // The failure is produced, not written: the search the IDE runs before an
  // edit throws it, with the closest region it found
  let error: any;
  try {
    executeFindAndReplace(
      project[STRINGS_PATH],
      EDIT_ARGS.old_string,
      EDIT_ARGS.new_string,
      false,
    );
  } catch (e) {
    error = e;
  }
  const cause = editFailureCauseOf(error?.reason);
  if (cause !== "not-found") {
    throw new Error(
      `edit-not-found: the scripted edit no longer fails as not found (${cause})`,
    );
  }
  return {
    id: "edit-not-found-after-person-edit",
    failureClass: "edit-not-found",
    what: "An exact-text edit of a file the person changed after the model read it: the old text is not there any more.",
    messages: [
      user(
        `In ${STRINGS_PATH}, make truncate end long text with three dots ("...") instead of the ellipsis character.`,
      ),
      assistantCall("g1", BuiltInToolNames.ReadFile, {
        filepath: STRINGS_PATH,
      }),
      toolResult("g1", SEED[STRINGS_PATH]),
      assistantCall("g2", tool, EDIT_ARGS),
    ],
    tools: [
      readFileTool,
      lsTool,
      grepSearchTool,
      createNewFileTool,
      singleFindAndReplaceTool,
      multiEditTool,
      runTerminalCommandTool,
    ],
    project,
    arms: {
      old: oldInvalidArguments(tool, error.message),
      // As preprocessToolCallArgs.ts builds it
      new: editFailureResult({
        tool,
        file: EDIT_ARGS.filepath,
        cause,
        detail: error.message,
      }),
    },
    // Re-read the file, or sent an edit whose old text is in it now. A
    // whole-file write is not offered a way to succeed: create_new_file
    // refuses a file that exists.
    succeeded: (call, files) =>
      readsFile(call, STRINGS_PATH) || editApplies(call, files, STRINGS_PATH),
    oracle: assistantCall("go1", BuiltInToolNames.ReadFile, {
      filepath: STRINGS_PATH,
    }),
  };
}

// ---------------------------------------------------------------------------
// 2. The Loop's question cap: a fifth call that needs approval in one item
// ---------------------------------------------------------------------------

const CAP_ITEM = {
  id: "1",
  text: "Confirm the package's tests pass, then add a capitalize(text) export to src/strings.js with a test in test/capitalize.test.js",
  status: "in_progress" as const,
};

/** Variations of one command, each held for approval; the last meets the cap. */
const CAP_COMMANDS = [
  "npm test",
  "node --test test/",
  "npm run test",
  "npx --no-install node --test test/",
  "node --test test/slugify.test.js test/truncate.test.js",
];

/** What the IDE puts before the cap's own sentence (gui/src/redux/thunks/loopHolds.ts). */
const CAP_PREFIX = "This call needs the person's approval and was not run.";

function questionCapCase(): GuidanceCase {
  const tool = BuiltInToolNames.RunTerminalCommand;
  const plan: TaskPlan = {
    items: [CAP_ITEM],
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
  const now = new Date(plan.updatedAt);
  let loop: LoopState = createLoop(plan, { now, sessionTokens: 0 });
  const messages: ChatMessage[] = [
    user(
      loopItemPrompt({
        item: CAP_ITEM,
        answers: [],
        questions: [],
        attempt: 1,
      }),
    ),
  ];
  let capError: string | undefined;
  CAP_COMMANDS.forEach((command, i) => {
    const id = `h${i + 1}`;
    messages.push(assistantCall(id, tool, { command }));
    // The loop's own state decides which call meets the cap
    const held = holdQuestion(
      loop,
      {
        itemId: CAP_ITEM.id,
        question: `Allow this call? ${command}`,
        kind: "approval",
        approval: {
          toolName: tool,
          summary: command,
          grantKey: loopGrantKey(tool, { command }),
        },
      },
      now,
    );
    if (held.ok) {
      loop = held.loop;
      messages.push(toolResult(id, approvalHeldResult(held.question)));
    } else {
      capError = held.error;
    }
  });
  if (
    !capError ||
    messages.length !== 2 * CAP_COMMANDS.length ||
    CAP_COMMANDS.length !== LOOP_LIMITS.maxOpenQuestionsPerItem + 1
  ) {
    throw new Error(
      "question-cap: the last scripted call, and only it, must meet the cap",
    );
  }
  const loopAtCap = loop;
  return {
    id: "question-cap-terminal-variations",
    failureClass: "question-cap",
    what: `A Loop item whose test command needs approval: ${LOOP_LIMITS.maxOpenQuestionsPerItem} variations are held as questions, and the next one meets the item's question cap.`,
    messages,
    tools: [
      readFileTool,
      lsTool,
      grepSearchTool,
      createNewFileTool,
      singleFindAndReplaceTool,
      runTerminalCommandTool,
      holdQuestionTool,
      finishItemTool,
    ],
    project: { ...SEED },
    arms: {
      // The cap's wording was not part of the 2026-11-22 rewrite, so `old`
      // and `new` read the same. Row AG7 ends the item's run at the cap
      // instead of answering, so once that is in, no next call follows
      // this text in the product: the class then records why (the old
      // text against the proposed one), not what the loop does today
      old: `${CAP_PREFIX} This item already holds 4 open questions. Continue on your stated assumptions, or call finish_item with outcome "waiting".`,
      new: `${CAP_PREFIX} ${capError}`,
      // Section 5 of the review; not in the code
      proposed:
        "No more calls will be held for approval in this item. Stop calling tools that need approval. Finish what needs none, then call finish_item with outcome waiting and name what needs approval.",
    },
    // It stopped: the next call is not another command (held again), and not
    // a question the same cap turns away
    succeeded: (call) => {
      if (call.name === tool) return false;
      if (call.name === BuiltInToolNames.HoldQuestion) {
        return holdQuestion(
          loopAtCap,
          { ...call.args, itemId: CAP_ITEM.id } as any,
          now,
        ).ok;
      }
      return true;
    },
    oracle: assistantCall("ho1", BuiltInToolNames.ReadFile, {
      filepath: STRINGS_PATH,
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. A tool name that does not exist
// ---------------------------------------------------------------------------

function unknownToolCase(): GuidanceCase {
  // The CLI's name with another product's parameter: no alias fits it, so
  // the call is answered and not run as read_file
  const name = "Read";
  const args = { file_path: STRINGS_PATH };
  const tools = [
    readFileTool,
    lsTool,
    grepSearchTool,
    createNewFileTool,
    singleFindAndReplaceTool,
    runTerminalCommandTool,
  ];
  const offered = tools.map((t) => ({
    name: t.function.name,
    required: t.function.parameters?.required as string[] | undefined,
  }));
  if (resolveToolAlias(name, args, offered)) {
    throw new Error(
      "unknown-tool: the scripted call now runs as an alias, so nothing fails",
    );
  }
  return {
    id: "unknown-tool-read",
    failureClass: "unknown-tool",
    what: "A read sent under a name the IDE does not offer (Read, with file_path).",
    messages: [
      user(
        `What does truncate in ${STRINGS_PATH} return when max is 0? Read the file before you answer.`,
      ),
      assistantCall("u1", name, args),
    ],
    tools,
    project: { ...SEED },
    arms: {
      // core.ts threw "Tool X not found" and the IDE wrapped it (before a3afcfc29)
      old: oldInvalidArguments(name, `Tool ${name} not found`),
      new: unknownToolResult(
        name,
        tools.map((t) => t.function.name),
      ),
    },
    // A real tool that does the job: the read the wrong name was meant to be
    succeeded: (call) => readsFile(call, STRINGS_PATH),
    oracle: assistantCall("uo1", BuiltInToolNames.ReadFile, {
      filepath: STRINGS_PATH,
    }),
  };
}

export const GUIDANCE_CASES: GuidanceCase[] = [
  editNotFoundCase(),
  questionCapCase(),
  unknownToolCase(),
];
