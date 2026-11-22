// How hard three Settings journeys are, as numbers: the journeys (what a
// person wants, in order), what is counted from a walk's trace, and the rule
// that says whether a run is worse than the baseline. Where each intent is
// done in today's layout is in walkLayout.mjs; the browser is driven by
// walkRun.mjs. Everything here but measureControl, bringIntoView and settle
// (which run in the page) is pure and has tests.
import fs from "node:fs";

export const WALK_WIDTHS = [300, 800];
/** The panel height of every walk. Scroll distances depend on it. */
export const WALK_HEIGHT = 700;
/** Scroll may grow by this many CSS pixels before it counts as worse: a font or a line of text moves a page by a few. */
export const SCROLL_TOLERANCE = 24;

/**
 * `goal` names the intent whose control is measured: where it is on its page
 * and how many controls come before it.
 */
export const JOURNEYS = [
  {
    id: "reach-mcp-list",
    title: "Reach the MCP server list",
    inputs: {},
    goal: "see the MCP server list",
    intents: [
      "open settings",
      "go to where MCP servers are",
      "see the MCP server list",
    ],
  },
  {
    id: "add-mcp-server",
    title: "Add an MCP server from a command line",
    inputs: {
      command: "npx -y @modelcontextprotocol/server-filesystem /tmp",
      serverName: "filesystem",
    },
    goal: "start adding a server",
    intents: [
      "open settings",
      "go to where MCP servers are",
      "start adding a server",
      "give the server's command line",
      "save the server",
      "see the server listed",
    ],
  },
  {
    id: "add-chat-model",
    title: "Add a chat model with an API key",
    // Not a key: the mock answers any value
    inputs: {
      provider: "Anthropic",
      apiKey: "sk-ant-walk-not-a-key",
      model: "Claude Sonnet 5.5",
    },
    goal: "start adding a model",
    intents: [
      "open settings",
      "go to where models are",
      "start adding a model",
      "choose the provider",
      "enter the API key",
      "test the connection",
      "choose the model",
      "save the model",
      "select the model for chat",
      "see the model selected for chat",
    ],
  },
];

/** The actions a person does on purpose. Looking (see, gone) is not one. */
export const STEP_KINDS = new Set([
  "ide",
  "click",
  "fill",
  "select",
  "check",
  "press",
]);

/** A layout that cannot do what a journey asks. The message names the intent. */
export class WalkError extends Error {}

/** "$name" in a map value becomes the journey's input of that name. */
export function fillIn(value, inputs) {
  if (typeof value !== "string") return value;
  return value.replace(/\$([A-Za-z]+)/g, (whole, name) => {
    if (!(name in inputs)) {
      throw new WalkError(`the layout map uses $${name}, not an input`);
    }
    return String(inputs[name]);
  });
}

/** A target of the layout map with the journey's inputs put in. */
export function resolveTarget(target, inputs) {
  const out = {};
  for (const [key, value] of Object.entries(target)) {
    out[key] =
      key === "within" ? resolveTarget(value, inputs) : fillIn(value, inputs);
  }
  return out;
}

/** A target as a person would say it, for messages and the trace. */
export function describeTarget(t) {
  if (!t) return "";
  const own = t.testId
    ? `[data-testid=${t.testId}]`
    : t.role
      ? `${t.role}${t.name ? ` "${t.name}"` : ""}`
      : t.label
        ? `field "${t.label}"`
        : t.text
          ? `text "${t.text}"`
          : (t.css ?? "?");
  return t.within ? `${own} in ${describeTarget(t.within)}` : own;
}

/** The actions of one intent in a layout; throws when the map does not know it. */
export function actionsFor(layout, intent, journeyId) {
  if (!(intent in layout.intents)) {
    throw new WalkError(
      `${journeyId}: the layout map has no entry for "${intent}". Add it to src/walkLayout.mjs.`,
    );
  }
  return layout.intents[intent];
}

/** How many deliberate actions a trace holds. A box that was already ticked is not one. */
export function countSteps(trace) {
  return trace.filter((e) => STEP_KINDS.has(e.do) && !e.skipped).length;
}

/**
 * Tokens a person must replace before a value works: <your-mcp-server>,
 * YOUR_API_KEY, CHANGEME. A reference such as ${{ secrets.NAME }} is not one.
 */
export function findPlaceholders(text) {
  if (!text) return [];
  const found = String(text).match(
    /<[A-Za-z][A-Za-z0-9]*(?:[-_ .][A-Za-z0-9]+)+>|\bYOUR[-_][A-Za-z0-9_-]+|\byour[-_][a-z0-9_-]+[-_]here\b|\b(?:CHANGE[-_]?ME|REPLACE[-_]?ME|TODO)\b/g,
  );
  return [...new Set(found ?? [])];
}

const lastPart = (uri) => String(uri).split(/[\\/]/).pop();

/**
 * Places where the person must know something the page did not say. Only what
 * can be seen mechanically: a placeholder in a file or a field, a field the
 * journey fills that has no label, and an end with nothing in the page to
 * confirm it.
 */
export function findDeadEnds({ trace, files, endsIn }) {
  const out = [];
  for (const f of files) {
    for (const token of findPlaceholders(f.content)) {
      out.push({
        kind: "placeholder",
        detail: `${token} in ${lastPart(f.uri)} must be replaced by hand`,
      });
    }
  }
  for (const e of trace) {
    if (["fill", "select", "check"].includes(e.do) && e.labelled === false) {
      out.push({
        kind: "no-label",
        detail: `"${e.intent}": the field has no label`,
      });
    }
    for (const token of e.valuePlaceholders ?? []) {
      out.push({
        kind: "placeholder",
        detail: `"${e.intent}": the field holds ${token}`,
      });
    }
  }
  const last = trace.at(-1);
  if (endsIn === "file" && last && !last.pageChanged) {
    out.push({
      kind: "no-confirmation",
      detail: `"${last.intent}": the page shows nothing new; what comes next is a file`,
    });
  }
  if (endsIn === "page" && last && last.do !== "see") {
    out.push({
      kind: "no-confirmation",
      detail: `"${last.intent}": the journey ends without the page showing the result`,
    });
  }
  return out;
}

/**
 * One journey at one width as numbers.
 * @param {object} o
 * @param {object} o.journey one of JOURNEYS
 * @param {number} o.width
 * @param {Array} o.trace the actions done, in order
 * @param {Array} o.files what opened in the editor: { via, uri, content }
 * @param {"page"|"file"|"failed"} o.endsIn
 * @param {string} [o.error] why it failed
 */
export function summarize({ journey, width, trace, files, endsIn, error }) {
  const goal = trace.findLast((e) => e.intent === journey.goal && e.target);
  const file = files.at(-1);
  return {
    journey: journey.id,
    width,
    steps: countSteps(trace),
    scrollPx: trace.reduce((n, e) => n + (e.scrollPx ?? 0), 0),
    goalY: goal?.y ?? null,
    controlsPassed: goal?.controlsBefore ?? null,
    controlsInPanel: goal?.controlsInPanel ?? null,
    pointerOnlyPassed: goal?.pointerOnlyBefore ?? null,
    filesOpened: files.length,
    endsIn,
    ...(endsIn === "file" && file
      ? {
          file: {
            name: lastPart(file.uri),
            via: file.via,
            bytes: file.content?.length ?? null,
            lines: file.content
              ? file.content.trimEnd().split("\n").length
              : null,
            placeholders: findPlaceholders(file.content),
          },
        }
      : {}),
    ...(error ? { error } : {}),
    deadEnds: findDeadEnds({ trace, files, endsIn }),
    trace,
  };
}

/** What the baseline keeps of a result: the numbers, not the trace. */
export function baselineEntry(r) {
  return {
    steps: r.steps,
    scrollPx: r.scrollPx,
    goalY: r.goalY,
    controlsPassed: r.controlsPassed,
    controlsInPanel: r.controlsInPanel,
    pointerOnlyPassed: r.pointerOnlyPassed,
    filesOpened: r.filesOpened,
    endsIn: r.endsIn,
    ...(r.file ? { fileBytes: r.file.bytes } : {}),
    deadEnds: r.deadEnds.length,
  };
}

// In the page is best; a file the person must edit is not success
const END_RANK = { failed: 0, file: 1, page: 2 };

/**
 * One run against its baseline entry. Worse: more steps, more scroll than the
 * tolerance allows, more controls passed, more files opened, or a worse end.
 * A better end is better whatever the numbers say: a journey that stopped at
 * a file left out the work done in the editor, so its steps are not the same
 * steps.
 * @returns {{ verdict: "worse"|"same"|"better"|"new", worse: string[], better: string[] }}
 */
export function compareRun(
  current,
  base,
  { tolerance = SCROLL_TOLERANCE } = {},
) {
  if (!base) return { verdict: "new", worse: [], better: [] };
  const worse = [];
  const better = [];
  const now = END_RANK[current.endsIn] ?? 0;
  const was = END_RANK[base.endsIn] ?? 0;
  if (now !== was) {
    const line = `ends in ${base.endsIn} -> ${current.endsIn}`;
    return now < was
      ? { verdict: "worse", worse: [line], better }
      : { verdict: "better", worse, better: [line] };
  }
  const number = (name, key, slack = 0) => {
    const a = base[key];
    const b = current[key];
    if (typeof a !== "number" || typeof b !== "number") return;
    if (b > a + slack) worse.push(`${name} ${a} -> ${b}`);
    else if (b < a - slack) better.push(`${name} ${a} -> ${b}`);
  };
  number("steps", "steps");
  number("scroll px", "scrollPx", tolerance);
  number("controls passed", "controlsPassed");
  number("files opened", "filesOpened");
  return {
    verdict: worse.length ? "worse" : better.length ? "better" : "same",
    worse,
    better,
  };
}

/** Every result against the baseline's journeys: { rows: [{ journey, width, verdict, worse, better }], failed } */
export function compareAll(results, journeys) {
  const rows = results.map((r) => ({
    journey: r.journey,
    width: r.width,
    ...compareRun(baselineEntry(r), journeys?.[r.journey]?.[String(r.width)]),
  }));
  return { rows, failed: rows.some((r) => r.verdict === "worse") };
}

/** The results as an aligned table, one line per journey and width. */
export function formatTable(results) {
  const head = [
    "journey",
    "width",
    "steps",
    "scroll px",
    "goal y",
    "tab stops before (in panel)",
    "pointer-only before",
    "files",
    "ends in",
    "dead ends",
  ];
  const cell = (v) => (v === null || v === undefined ? "-" : String(v));
  const rows = results.map((r) => [
    r.journey,
    r.width,
    r.steps,
    r.scrollPx,
    r.goalY,
    r.controlsPassed === null
      ? null
      : `${r.controlsPassed} (${cell(r.controlsInPanel)})`,
    r.pointerOnlyPassed,
    r.filesOpened,
    r.endsIn === "file" && r.file
      ? `file (${cell(r.file.bytes)} chars, ${cell(r.file.lines)} lines)`
      : r.endsIn,
    r.deadEnds.length,
  ]);
  const all = [head, ...rows].map((row) => row.map(cell));
  const wide = head.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return all
    .map((row) =>
      row
        .map((c, i) => c.padEnd(wide[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function readWalkBaseline(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")).journeys ?? {};
}

export function writeWalkBaseline(file, results, meta) {
  const journeys = {};
  for (const r of results) {
    (journeys[r.journey] ??= {})[String(r.width)] = baselineEntry(r);
  }
  fs.writeFileSync(file, JSON.stringify({ ...meta, journeys }, null, 2) + "\n");
}

/**
 * Runs in the page, on the control about to be used, before anything scrolls.
 * - y: its top edge on the unscrolled page, as a tall picture would show it;
 * - controlsBefore: the Tab stops that come before it in document order
 *   (inside its dialog when it is in one): visible, enabled, tabindex 0 or
 *   more, a radio group once;
 * - controlsInPanel: those of them in the same tab panel;
 * - pointerOnlyBefore: things before it that take a click but not the Tab key
 *   (the pointer cursor on something that neither is nor holds a focusable
 *   element). A guess from the cursor: the page does not say what is clickable;
 * - labelled: whether a form field has a name a person can read.
 */
export function measureControl(el) {
  const rect = el.getBoundingClientRect();
  let y = rect.top + window.scrollY;
  for (let p = el.parentElement; p; p = p.parentElement) y += p.scrollTop;

  const scope = el.closest('[role="dialog"]') ?? document;
  const focusable =
    'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';
  const comesBefore = (e) =>
    e !== el &&
    !!(e.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const radios = new Set();
  const stops = [...scope.querySelectorAll(focusable)].filter((e) => {
    if (e.disabled || e.tabIndex < 0 || e.type === "hidden") return false;
    if (e.closest('[inert], [aria-hidden="true"]')) return false;
    if (!e.getClientRects().length) return false;
    if (getComputedStyle(e).visibility === "hidden") return false;
    if (e.type === "radio" && e.name) {
      if (radios.has(e.name)) return false;
      radios.add(e.name);
    }
    return true;
  });
  const before = stops.filter(comesBefore);
  const panel = el.closest('[role="tabpanel"]');
  const pointer = (e) => getComputedStyle(e).cursor === "pointer";
  const pointerOnly = [...scope.querySelectorAll("*")].filter(
    (e) =>
      comesBefore(e) &&
      !e.contains(el) &&
      e.getClientRects().length > 0 &&
      pointer(e) &&
      // the outermost element of a clickable thing, once
      !(e.parentElement && pointer(e.parentElement)) &&
      !e.closest(focusable) &&
      !e.querySelector(focusable),
  );

  const field = el.matches("input, select, textarea");
  const labelled = !field
    ? null
    : !!(
        el.labels?.length ||
        el.getAttribute("aria-label")?.trim() ||
        el.getAttribute("aria-labelledby") ||
        el.title?.trim()
      );
  return {
    y: Math.round(y),
    controlsBefore: before.length,
    controlsInPanel: panel
      ? before.filter((e) => panel.contains(e)).length
      : null,
    pointerOnlyBefore: pointerOnly.length,
    labelled,
    value: field && el.type !== "password" ? String(el.value ?? "") : "",
  };
}

/**
 * Runs in the page. Scrolls the control into view by the least distance, as a
 * person scrolls until they see it, and returns the pixels every scrolling
 * box (and the window) moved, added up.
 */
export function bringIntoView(el) {
  const boxes = [];
  for (let p = el.parentElement; p; p = p.parentElement) boxes.push(p);
  const read = () => [
    window.scrollX,
    window.scrollY,
    ...boxes.flatMap((b) => [b.scrollLeft, b.scrollTop]),
  ];
  const before = read();
  el.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
  return Math.round(read().reduce((n, v, i) => n + Math.abs(v - before[i]), 0));
}

/**
 * Runs in the page. Resolves when the page has stopped changing: the same
 * number of elements, the same text length and the same heights for `frames`
 * animation frames in a row. Waits on the page, not on a clock.
 */
export function settle(frames = 8) {
  return new Promise((resolve, reject) => {
    const signature = () => {
      const all = document.getElementsByTagName("*");
      let heights = 0;
      for (const e of all) heights += e.scrollHeight;
      return `${all.length}|${document.body.innerText.length}|${heights}`;
    };
    let last = signature();
    let same = 0;
    let seen = 0;
    const tick = () => {
      const now = signature();
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= frames) return resolve(seen);
      if (++seen > 1200) {
        return reject(new Error("the page did not come to rest"));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
