// The named views the tool can draw. A view is a fixture of
// harness/fixtures.ts (the state the real app is put into) plus a short note.
// Keep this list in step with FIXTURES there; test/views.test.mjs checks it.
export const VIEWS = {
  chat: {
    fixture: "idle",
    note: "a new, empty chat with the input and its toolbar",
  },
  conversation: {
    fixture: "conversation",
    note: "a finished exchange with markdown and a code block",
  },
  streaming: { fixture: "streaming", note: "a reply that is still arriving" },
  "tool-call": {
    fixture: "tool-call",
    note: "a terminal command card waiting for approval",
  },
  approval: {
    fixture: "approval",
    note: "three calls waiting for approval: a long command, a path outside the workspace, an MCP tool",
  },
  "tool-call-done": {
    fixture: "tool-call-done",
    note: "the same command after it ran",
  },
  held: {
    fixture: "held",
    note: "a reply held back while it is checked for a tool request",
  },
  dialect: {
    fixture: "dialect",
    note: "the notice that a model wrote a tool request as plain text",
  },
  "attach-open": {
    fixture: "attach-open",
    note: 'the "+" menu at the left of the prompt, open',
  },
  "status-row": {
    fixture: "status-row",
    note: "the row under the prompt after a reply: usage, reasoning, prompt cache",
  },
  "usage-open": {
    fixture: "usage-open",
    note: "the usage breakdown, opened from the readout under the prompt",
  },
  "context-open": {
    fixture: "context-open",
    note: "what the context holds, opened from the context meter under the prompt",
  },
  "preset-open": {
    fixture: "preset-open",
    note: "the preset picker above the input, open: a glyph and a tone for each preset",
  },
  loop: {
    fixture: "loop",
    note: "Loop mode: the plan card, per-item budgets and loop controls",
  },
  "loop-running": {
    fixture: "loop-running",
    note: "Loop mode, running item 2: the status line with Now:, progress, round and budget",
  },
  "loop-questions": {
    fixture: "loop-questions",
    note: "Loop mode with three questions waiting: the Needs you tray shows one at a time",
  },
  "loop-replan": {
    fixture: "loop-replan",
    note: "Loop mode with a re-plan waiting: the Needs you tray holds Review diff, Keep planning and Accept plan",
  },
  "loop-failed": {
    fixture: "loop-failed",
    note: "Loop mode, a failed item being repaired: the red state",
  },
  "loop-finished": {
    fixture: "loop-finished",
    note: "Loop mode, every item done: the green state, Close",
  },
  "loop-stopped": {
    fixture: "loop-stopped",
    note: "Loop mode stopped by the person: Resume and Close",
  },
  "loop-settings-open": {
    fixture: "loop-settings-open",
    note: "Loop mode with the gear opened: strategy, Parallel and the note",
  },
  "loop-plan-tile": {
    fixture: "loop-plan-tile",
    note: "Loop mode: the plan card as a collapsed tile (title, file link, round line, one root row)",
  },
  "loop-plan-running": {
    fixture: "loop-plan-running",
    note: "Loop mode: the plan tree open while running: done fold, current item with live lines, upcoming rows, trace and auto-answer",
  },
  "loop-plan-waiting": {
    fixture: "loop-plan-waiting",
    note: "Loop mode: a re-plan waits to be accepted: dropped struck through, new to-do, kept folded; opens by itself",
  },
  "loop-plan-failed": {
    fixture: "loop-plan-failed",
    note: "Loop mode: an item failed and a repair runs: check output, fix-forward line; opens by itself",
  },
  "loop-plan-finished": {
    fixture: "loop-plan-finished",
    note: "Loop mode: finished, every to-do done folded into one row",
  },
  "loop-idgaf": {
    fixture: "loop-idgaf",
    note: "Loop mode at IDGAF with seven blocked calls: the one-line IDGAF chip and the blocked badge in the mode bar",
  },
  "loop-blocked-open": {
    fixture: "loop-blocked-open",
    note: "Loop mode: the Recently blocked list opened from its badge",
  },
  "settings-models": {
    fixture: "settings-models",
    note: "Settings, Models tab",
  },
  "settings-rules": { fixture: "settings-rules", note: "Settings, Rules tab" },
  "settings-permissions": {
    fixture: "settings-permissions",
    note: "Settings, Permissions tab (render only)",
  },
  "settings-configs": {
    fixture: "settings-configs",
    note: "Settings, Configs tab",
  },
  "settings-indexing": {
    fixture: "settings-indexing",
    note: "Settings, Indexing tab",
  },
  "settings-general": {
    fixture: "settings-general",
    note: "Settings, Settings tab",
  },
  "settings-help": { fixture: "settings-help", note: "Settings, Help tab" },
  "agents-running": {
    fixture: "agents-running",
    note: "the agents panel: Active and Done groups, long names, unknown costs",
  },
  "agents-ended": {
    fixture: "agents-ended",
    note: "the agents panel after every agent ended (Done folded), one interrupted",
  },
  catalogue: {
    fixture: "catalogue",
    note: "OpenRouter provider setup with the one-time prompt to pull the model list",
  },
  "bedrock-ok": {
    fixture: "bedrock-ok",
    note: "Bedrock Test connection, success",
  },
  "bedrock-fail": {
    fixture: "bedrock-fail",
    note: "Bedrock Test connection, failure",
  },
  "permissions-editor": {
    fixture: "permissions-editor",
    note: "Settings, Permissions, with the add-rule form open on a rule that allows every command",
  },
  "permissions-loading": {
    fixture: "permissions-loading",
    note: "Settings, Permissions, while the rules are read, with the slow-read line",
  },
  "permissions-error": {
    fixture: "permissions-error",
    note: "Settings, Permissions, when the read failed: the error and Retry",
  },
  "permissions-intro": {
    fixture: "permissions-intro",
    note: "Settings, Permissions, with the first-run overview card",
  },
  "chat-first-run": {
    fixture: "chat-first-run",
    note: "a new chat for a first-time user, with the one-line first-run notice",
  },
  "audit-list": {
    fixture: "audit-list",
    note: "Settings, Permissions, Recent calls: decisions, who decided, agents, filters",
  },
  "audit-inbox": {
    fixture: "audit-inbox",
    note: "Settings, Permissions, Inbox: open asks oldest first, ages, possibly-ended label, Show older",
  },
  "onboarding-local": {
    fixture: "onboarding-local",
    note: "Onboarding, Local tab: the suggested model with Connect and Configure model",
  },
  "onboarding-local-chooser": {
    fixture: "onboarding-local-chooser",
    note: "Onboarding, Local tab, with the Configure model chooser open",
  },
  "onboarding-local-server": {
    fixture: "onboarding-local-server",
    note: "The chooser on an OpenAI-compatible server, with More open",
  },
  "loop-frame-running": {
    fixture: "loop-frame-running",
    note: "the gradient loop frame round a stand-in loop dock, running",
  },
  "loop-frame-waiting": {
    fixture: "loop-frame-waiting",
    note: "the loop frame, solid amber: waiting on you",
  },
  "loop-frame-failed": {
    fixture: "loop-frame-failed",
    note: "the loop frame, solid red: an item failed, repairing",
  },
  "loop-frame-finished": {
    fixture: "loop-frame-finished",
    note: "the loop frame, solid green: finished",
  },
  "loop-frame-stopped": {
    fixture: "loop-frame-stopped",
    note: "the loop frame, solid grey: stopped",
  },
  "settings-tools": {
    fixture: "settings-tools",
    note: "Settings, Tools tab, with Commands and secrets",
  },
  "drop-target": {
    fixture: "drop-target",
    note: "the chat input while a file is dragged over it: the drop target and the VS Code Shift hint",
  },
  "drop-refused": {
    fixture: "drop-refused",
    note: "the chat input after a drop of .env and a file outside the workspace: the refusal note",
  },
};

export const VIEW_NAMES = Object.keys(VIEWS);

export const DEFAULTS = {
  widths: [300, 800],
  themes: ["dark", "light"],
  height: 700,
};

/** "a,b" or "a" or "all" to a list of known view names; throws on an unknown one. */
export function parseViews(value) {
  if (!value || value === "all") return [...VIEW_NAMES];
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!VIEWS[n]) {
      throw new Error(`Unknown view "${n}". Known: ${VIEW_NAMES.join(", ")}`);
    }
  }
  return names;
}

/** "300,800" to [300, 800]; each must be a whole number from 200 to 3000. */
export function parseWidths(value) {
  if (!value) return [...DEFAULTS.widths];
  return value.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 200 || n > 3000) {
      throw new Error(`Bad width "${s}": a whole number from 200 to 3000`);
    }
    return n;
  });
}

/** "dark,light" or "both" to a list of themes. */
export function parseThemes(value) {
  if (!value || value === "both") return [...DEFAULTS.themes];
  return value.split(",").map((s) => {
    const t = s.trim();
    if (t !== "dark" && t !== "light" && t !== "hc") {
      throw new Error(`Bad theme "${s}": dark, light or hc`);
    }
    return t;
  });
}

/** The file name of one picture. */
export function shotName(view, width, theme) {
  return `${view}-${width}-${theme}.png`;
}

/** The full list of pictures for a request, in a stable order. */
export function planJobs({ views, widths, themes, height }) {
  const jobs = [];
  for (const view of views) {
    for (const width of widths) {
      for (const theme of themes) {
        jobs.push({
          view,
          fixture: VIEWS[view].fixture,
          width,
          height,
          theme,
          name: shotName(view, width, theme),
        });
      }
    }
  }
  return jobs;
}
