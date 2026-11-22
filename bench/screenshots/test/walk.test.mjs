import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  actionsFor,
  baselineEntry,
  CHECK_METRICS,
  compareAll,
  compareRun,
  countSteps,
  describeTarget,
  fillIn,
  findDeadEnds,
  findPlaceholders,
  formatTable,
  JOURNEYS,
  parseCheckOnly,
  resolveTarget,
  SCROLL_TOLERANCE,
  STEP_KINDS,
  summarize,
  WalkError,
} from "../src/walk.mjs";
import { LAYOUT } from "../src/walkLayout.mjs";

const step = (intent, kind, over = {}) => ({
  intent,
  do: kind,
  target: "x",
  scrollPx: 0,
  pageChanged: true,
  ...over,
});

describe("countSteps", () => {
  it("counts each deliberate action once", () => {
    const trace = [
      step("open settings", "ide"),
      step("go", "click"),
      step("key", "fill"),
      step("command", "paste"),
      step("storage", "select"),
      step("model", "check"),
      step("commit", "press"),
    ];
    assert.equal(countSteps(trace), 7);
  });

  it("does not count looking, waiting, or a box that was already ticked", () => {
    const trace = [
      step("go", "click"),
      step("look", "see"),
      step("closed", "gone"),
      step("model", "check", { skipped: true }),
    ];
    assert.equal(countSteps(trace), 1);
    assert.equal(countSteps([]), 0);
  });

  it("counts two actions of one intent as two steps", () => {
    assert.equal(countSteps([step("pick", "click"), step("pick", "click")]), 2);
  });
});

describe("findPlaceholders", () => {
  it("finds the token of the MCP server template", () => {
    const yaml =
      "name: New MCP server\nmcpServers:\n  - command: npx\n    args:\n      - -y\n      - <your-mcp-server>\n";
    assert.deepEqual(findPlaceholders(yaml), ["<your-mcp-server>"]);
  });

  it("finds upper-case and here-style tokens, each once", () => {
    assert.deepEqual(
      findPlaceholders(
        "key: YOUR_API_KEY\nurl: <API_BASE>\nagain: YOUR_API_KEY",
      ),
      ["YOUR_API_KEY", "<API_BASE>"],
    );
    assert.deepEqual(findPlaceholders("token: your-token-here"), [
      "your-token-here",
    ]);
    assert.deepEqual(findPlaceholders("model: CHANGEME # TODO"), [
      "CHANGEME",
      "TODO",
    ]);
  });

  it("leaves real values, secret references and markup alone", () => {
    assert.deepEqual(
      findPlaceholders(
        "apiKey: ${{ secrets.ANTHROPIC_API_KEY }}\nargs: [-y, @modelcontextprotocol/server-filesystem, /tmp]\n<div>a < b > c</div>",
      ),
      [],
    );
    assert.deepEqual(findPlaceholders(""), []);
    assert.deepEqual(findPlaceholders(undefined), []);
  });
});

/** A journey that went well, as the baseline keeps it. */
const entry = (over = {}) => ({
  steps: 5,
  scrollPx: 1000,
  goalY: 1500,
  controlsPassed: 20,
  controlsInPanel: 18,
  filesOpened: 0,
  endsIn: "page",
  deadEnds: 0,
  ...over,
});

describe("compareRun", () => {
  it("says same when nothing moved, and within the scroll tolerance", () => {
    assert.equal(compareRun(entry(), entry()).verdict, "same");
    const over = entry({ scrollPx: 1000 + SCROLL_TOLERANCE });
    assert.equal(compareRun(over, entry()).verdict, "same");
    const under = entry({ scrollPx: 1000 - SCROLL_TOLERANCE });
    assert.equal(compareRun(under, entry()).verdict, "same");
  });

  it("says worse for each number that grew", () => {
    assert.deepEqual(compareRun(entry({ steps: 6 }), entry()).worse, [
      "steps 5 -> 6",
    ]);
    assert.deepEqual(
      compareRun(entry({ scrollPx: 1001 + SCROLL_TOLERANCE }), entry()).worse,
      [`scroll px 1000 -> ${1001 + SCROLL_TOLERANCE}`],
    );
    assert.deepEqual(compareRun(entry({ controlsPassed: 21 }), entry()).worse, [
      "controls passed 20 -> 21",
    ]);
    assert.deepEqual(compareRun(entry({ filesOpened: 1 }), entry()).worse, [
      "files opened 0 -> 1",
    ]);
    assert.equal(compareRun(entry({ steps: 6 }), entry()).verdict, "worse");
  });

  it("says better when numbers fell, and worse when any other grew", () => {
    const r = compareRun(entry({ steps: 3, scrollPx: 0 }), entry());
    assert.equal(r.verdict, "better");
    assert.deepEqual(r.better, ["steps 5 -> 3", "scroll px 1000 -> 0"]);
    const mixed = compareRun(entry({ steps: 3, controlsPassed: 30 }), entry());
    assert.equal(mixed.verdict, "worse");
    assert.deepEqual(mixed.better, ["steps 5 -> 3"]);
  });

  it("takes a tolerance of its own", () => {
    const r = compareRun(entry({ scrollPx: 1010 }), entry(), { tolerance: 5 });
    assert.equal(r.verdict, "worse");
  });

  it("ranks the end first: a file or a failure is worse than the page", () => {
    const file = entry({ endsIn: "file", steps: 3, filesOpened: 1 });
    assert.deepEqual(compareRun(file, entry()), {
      verdict: "worse",
      worse: ["ends in page -> file"],
      better: [],
    });
    assert.equal(
      compareRun(entry({ endsIn: "failed" }), file).verdict,
      "worse",
    );
    // more steps, but they now end in the page and not in a YAML file
    const dialog = entry({ steps: 6 });
    assert.deepEqual(compareRun(dialog, file), {
      verdict: "better",
      worse: [],
      better: ["ends in file -> page"],
    });
  });

  it("says new without a baseline entry, and skips a number that is missing", () => {
    assert.equal(compareRun(entry(), undefined).verdict, "new");
    assert.equal(
      compareRun(entry({ controlsPassed: null }), entry()).verdict,
      "same",
    );
  });
});

describe("compareRun with only some metrics", () => {
  const only = parseCheckOnly("steps,files,ends,tabstops");

  it("leaves scroll out, in both directions", () => {
    const more = compareRun(entry({ scrollPx: 5000 }), entry(), { only });
    assert.deepEqual(more, { verdict: "same", worse: [], better: [] });
    assert.equal(
      compareRun(entry({ scrollPx: 0 }), entry(), { only }).verdict,
      "same",
    );
    // and without the option it still counts
    assert.equal(
      compareRun(entry({ scrollPx: 5000 }), entry()).verdict,
      "worse",
    );
  });

  it("still fails on each number that is compared, and on a worse end", () => {
    for (const over of [
      { steps: 6 },
      { controlsPassed: 21 },
      { filesOpened: 1 },
      { endsIn: "file" },
      { endsIn: "failed" },
    ]) {
      const r = compareRun(entry({ scrollPx: 0, ...over }), entry(), { only });
      assert.equal(r.verdict, "worse", JSON.stringify(over));
    }
  });

  it("compares nothing it was not asked to", () => {
    const worseEverywhere = entry({
      steps: 9,
      scrollPx: 9000,
      controlsPassed: 99,
      filesOpened: 3,
      endsIn: "file",
    });
    assert.deepEqual(
      compareRun(worseEverywhere, entry(), { only: ["steps"] }).worse,
      ["steps 5 -> 9"],
    );
    assert.deepEqual(
      compareRun(worseEverywhere, entry(), { only: ["scroll"] }).worse,
      ["scroll px 1000 -> 9000"],
    );
  });

  it("reaches every journey through compareAll", () => {
    const result = (over) => ({
      journey: "a",
      width: 300,
      ...entry(over),
      deadEnds: [],
    });
    const base = { a: { 300: entry() } };
    const scrolled = [result({ scrollPx: 5000 })];
    assert.equal(compareAll(scrolled, base).failed, true);
    assert.equal(compareAll(scrolled, base, { only }).failed, false);
    assert.equal(
      compareAll([result({ steps: 6 })], base, { only }).failed,
      true,
    );
  });
});

describe("parseCheckOnly", () => {
  it("reads a list in any order, with spaces, each name once", () => {
    assert.deepEqual(parseCheckOnly("tabstops, steps,files,ends,steps"), [
      "ends",
      "steps",
      "tabstops",
      "files",
    ]);
    assert.deepEqual(parseCheckOnly(CHECK_METRICS.join(",")), CHECK_METRICS);
  });

  it("refuses a name that is not a metric, and an empty list", () => {
    assert.throws(() => parseCheckOnly("steps,goaly"), /not goaly/);
    assert.throws(() => parseCheckOnly(""), /--check-only takes a list/);
    assert.throws(() => parseCheckOnly(undefined), /--check-only takes a list/);
    // a missing value swallows the next flag
    assert.throws(() => parseCheckOnly("--browser"), /not --browser/);
  });
});

describe("compareAll", () => {
  it("fails when any journey at any width is worse", () => {
    const result = (journey, width, over) => ({
      journey,
      width,
      ...entry(over),
      deadEnds: [],
    });
    const base = { a: { 300: entry(), 800: entry() } };
    const ok = compareAll([result("a", 300), result("a", 800)], base);
    assert.equal(ok.failed, false);
    const bad = compareAll(
      [result("a", 300), result("a", 800, { steps: 9 })],
      base,
    );
    assert.equal(bad.failed, true);
    assert.deepEqual(
      bad.rows.map((r) => r.verdict),
      ["same", "worse"],
    );
    assert.equal(compareAll([result("b", 300)], base).failed, false);
  });
});

describe("findDeadEnds", () => {
  const files = [
    {
      via: "config/addLocalWorkspaceBlock",
      uri: "file:///w/.continuous/mcpServers/new-mcp-server.yaml",
      content: "args:\n  - <your-mcp-server>\n",
    },
  ];

  it("reports a placeholder in the file and a page that said nothing", () => {
    const trace = [
      step("start adding a server", "click", { pageChanged: false }),
    ];
    assert.deepEqual(findDeadEnds({ trace, files, endsIn: "file" }), [
      {
        kind: "placeholder",
        detail:
          "<your-mcp-server> in new-mcp-server.yaml must be replaced by hand",
      },
      {
        kind: "no-confirmation",
        detail:
          '"start adding a server": the page shows nothing new; what comes next is a file',
      },
    ]);
  });

  it("reports a field without a label and a field that holds a placeholder", () => {
    const trace = [
      step("enter the key", "fill", {
        labelled: false,
        valuePlaceholders: ["YOUR_API_KEY"],
      }),
      step("see it", "see"),
    ];
    assert.deepEqual(
      findDeadEnds({ trace, files: [], endsIn: "page" }).map((d) => d.kind),
      ["no-label", "placeholder"],
    );
  });

  it("asks a pasted field for a label as it asks a typed one", () => {
    const trace = [
      step("give the command line", "paste", { labelled: false }),
      step("see it", "see"),
    ];
    assert.deepEqual(findDeadEnds({ trace, files: [], endsIn: "page" }), [
      {
        kind: "no-label",
        detail: '"give the command line": the field has no label',
      },
    ]);
  });

  it("reports a journey that ends in the page without the page showing it", () => {
    const done = [step("save", "click")];
    assert.deepEqual(
      findDeadEnds({ trace: done, files: [], endsIn: "page" }).map(
        (d) => d.kind,
      ),
      ["no-confirmation"],
    );
    const shown = [...done, step("see it listed", "see")];
    assert.deepEqual(
      findDeadEnds({ trace: shown, files: [], endsIn: "page" }),
      [],
    );
  });
});

describe("summarize", () => {
  const journey = {
    id: "j",
    goal: "start",
    intents: ["open", "start", "finish"],
  };

  it("adds the scroll up and reads the goal's place and controls", () => {
    const trace = [
      step("open", "ide"),
      step("start", "click", {
        scrollPx: 120,
        y: 900,
        controlsBefore: 12,
        controlsInPanel: 10,
        pointerOnlyBefore: 3,
      }),
      step("finish", "see", { scrollPx: 30, y: 40, controlsBefore: 1 }),
    ];
    const r = summarize({
      journey,
      width: 800,
      trace,
      files: [],
      endsIn: "page",
    });
    assert.equal(r.steps, 2);
    assert.equal(r.scrollPx, 150);
    assert.equal(r.goalY, 900);
    assert.equal(r.controlsPassed, 12);
    assert.equal(r.controlsInPanel, 10);
    assert.equal(r.pointerOnlyPassed, 3);
    assert.equal(r.filesOpened, 0);
    assert.equal(r.file, undefined);
    assert.deepEqual(r.deadEnds, []);
  });

  it("describes the file a journey ends in", () => {
    const content = "name: New MCP server\nargs:\n  - <your-mcp-server>\n";
    const r = summarize({
      journey,
      width: 300,
      trace: [step("start", "click", { y: 5, controlsBefore: 0 })],
      files: [
        { via: "config/addLocalWorkspaceBlock", uri: "a/b/new.yaml", content },
      ],
      endsIn: "file",
    });
    assert.deepEqual(r.file, {
      name: "new.yaml",
      via: "config/addLocalWorkspaceBlock",
      bytes: content.length,
      lines: 3,
      placeholders: ["<your-mcp-server>"],
    });
    assert.equal(r.filesOpened, 1);
    assert.equal(baselineEntry(r).fileBytes, content.length);
    assert.equal(baselineEntry(r).deadEnds, 1);
    assert.equal(baselineEntry(r).trace, undefined);
  });

  it("keeps the reason of a journey that could not be walked", () => {
    const r = summarize({
      journey,
      width: 800,
      trace: [step("open", "ide")],
      files: [],
      endsIn: "failed",
      error: 'j: cannot "start"',
    });
    assert.equal(r.endsIn, "failed");
    assert.equal(r.error, 'j: cannot "start"');
    assert.equal(r.goalY, null);
  });
});

describe("the layout map", () => {
  it("has an entry for every intent of every journey", () => {
    for (const j of JOURNEYS) {
      assert.ok(j.intents.includes(j.goal), `${j.id}: goal is not an intent`);
      for (const intent of j.intents) {
        const actions = actionsFor(LAYOUT, intent, j.id);
        assert.ok(
          actions === null || Array.isArray(actions),
          `${j.id}: ${intent}`,
        );
      }
    }
  });

  it("uses only known actions, and inputs the journey has", () => {
    const known = new Set([...STEP_KINDS, "see", "gone"]);
    for (const j of JOURNEYS) {
      for (const intent of j.intents) {
        for (const a of LAYOUT.intents[intent] ?? []) {
          assert.ok(known.has(a.do), `${intent}: ${a.do}`);
          if (a.target) resolveTarget(a.target, j.inputs);
          fillIn(a.value, j.inputs);
        }
      }
    }
  });

  it("names the intent when the map does not know it", () => {
    assert.throws(
      () => actionsFor({ intents: {} }, "open the moon", "j"),
      (e) =>
        e instanceof WalkError &&
        /j: the layout map has no entry for "open the moon"/.test(e.message),
    );
  });
});

describe("targets", () => {
  it("puts inputs in, also inside within", () => {
    const t = resolveTarget(
      { within: { testId: "row-$id" }, role: "option", name: "$model" },
      { id: "7", model: "Claude" },
    );
    assert.deepEqual(t, {
      within: { testId: "row-7" },
      role: "option",
      name: "Claude",
    });
    assert.equal(describeTarget(t), 'option "Claude" in [data-testid=row-7]');
    assert.equal(describeTarget({ label: "API key" }), 'field "API key"');
  });

  it("refuses an input the journey does not have", () => {
    assert.throws(() => fillIn("$nope", {}), WalkError);
    assert.equal(fillIn(undefined, {}), undefined);
    assert.equal(fillIn("plain", {}), "plain");
  });
});

describe("formatTable", () => {
  it("draws one aligned line per journey and width", () => {
    const text = formatTable([
      {
        journey: "a",
        width: 300,
        ...entry({ endsIn: "file", filesOpened: 1, pointerOnlyPassed: 2 }),
        file: { bytes: 160, lines: 10 },
        deadEnds: [{}, {}],
      },
      { journey: "a", width: 800, ...entry({ goalY: null }), deadEnds: [] },
    ]);
    const lines = text.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^journey\s+width\s+steps\s+scroll px\s+goal y/);
    assert.match(lines[1], /file \(160 chars, 10 lines\)\s+2$/);
    assert.match(
      lines[2],
      /^a\s+800\s+5\s+1000\s+-\s+20 \(18\)\s+-\s+0\s+page\s+0$/,
    );
  });
});
