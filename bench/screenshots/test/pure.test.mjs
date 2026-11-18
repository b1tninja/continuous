import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/args.mjs";
import { chooseBrowser } from "../src/browser.mjs";
import { countDiff, pairEntries, summarize } from "../src/diff.mjs";
import { resolveRequest } from "../src/server.mjs";
import {
  parseThemes,
  parseViews,
  parseWidths,
  planJobs,
  shotName,
  VIEW_NAMES,
  VIEWS,
} from "../src/views.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("views", () => {
  it("every view names a fixture that harness/fixtures.ts defines", () => {
    const text = ["fixtures.ts", "auditFixtures.ts"]
      .map((f) => fs.readFileSync(path.join(here, "..", "harness", f), "utf8"))
      .join("\n");
    for (const [name, v] of Object.entries(VIEWS)) {
      assert.ok(
        new RegExp(`(^|\\s)"?${v.fixture}"?:\\s`, "m").test(text),
        `view ${name}: fixture ${v.fixture} is not in fixtures.ts or auditFixtures.ts`,
      );
    }
  });

  it("parses lists and refuses unknown names", () => {
    assert.deepEqual(parseViews("all"), VIEW_NAMES);
    assert.deepEqual(parseViews("chat, loop"), ["chat", "loop"]);
    assert.throws(() => parseViews("chta"), /Unknown view "chta"/);
    assert.deepEqual(parseWidths("300,800"), [300, 800]);
    assert.throws(() => parseWidths("10"), /Bad width/);
    assert.throws(() => parseWidths("abc"), /Bad width/);
    assert.deepEqual(parseThemes("both"), ["dark", "light"]);
    assert.throws(() => parseThemes("blue"), /Bad theme/);
  });

  it("plans one job per view, width and theme in a stable order", () => {
    const jobs = planJobs({
      views: ["chat", "loop"],
      widths: [300, 800],
      themes: ["dark", "light"],
      height: 700,
    });
    assert.equal(jobs.length, 8);
    assert.equal(jobs[0].name, "chat-300-dark.png");
    assert.equal(jobs[1].name, "chat-300-light.png");
    assert.equal(jobs[7].name, shotName("loop", 800, "light"));
    assert.equal(jobs[0].fixture, "idle");
  });
});

describe("args", () => {
  it("needs --out and rejects unknown options and values", () => {
    assert.throws(() => parseArgs([]), /--out/);
    assert.throws(() => parseArgs(["--out", "x", "--nope"]), /Unknown option/);
    assert.throws(() => parseArgs(["--out"]), /needs a value/);
    assert.throws(() => parseArgs(["--out", "x", "stray"]), /Unexpected/);
    assert.throws(
      () => parseArgs(["--out", "x", "--browser", "ie"]),
      /--browser/,
    );
    assert.throws(
      () => parseArgs(["--out", "x", "--threshold", "2"]),
      /--threshold/,
    );
  });

  it("applies the defaults", () => {
    const o = parseArgs(["--out", "x"]);
    assert.equal(o.jobs.length, VIEW_NAMES.length * 4);
    assert.equal(o.browser, "auto");
    assert.equal(o.sandbox, false);
    assert.equal(o.threshold, 0.1);
    assert.equal(o.tolerance, 0.001);
  });

  it("takes a single view, width and theme", () => {
    const o = parseArgs([
      "--view",
      "chat",
      "--width",
      "300",
      "--theme",
      "dark",
      "--out",
      "x",
      "--diff",
      "y",
    ]);
    assert.deepEqual(
      o.jobs.map((j) => j.name),
      ["chat-300-dark.png"],
    );
    assert.equal(o.diff, "y");
  });

  it("--list and --help need no --out", () => {
    assert.equal(parseArgs(["--list"]).list, true);
    assert.equal(parseArgs(["--help"]).help, true);
  });
});

describe("diff", () => {
  const px = (...rgba) => Uint8ClampedArray.from(rgba);

  it("counts only pixels beyond the threshold", () => {
    const a = px(0, 0, 0, 255, 100, 100, 100, 255, 255, 255, 255, 255);
    const b = px(0, 0, 0, 255, 104, 100, 100, 255, 0, 0, 0, 255);
    assert.equal(countDiff(a, b, 0.1), 1);
    assert.equal(countDiff(a, b, 0.001), 2);
    assert.equal(countDiff(a, a, 0), 0);
  });

  it("paints changed pixels magenta and dims the rest", () => {
    const a = px(0, 0, 0, 255, 200, 200, 200, 255);
    const b = px(255, 255, 255, 255, 200, 200, 200, 255);
    const mark = new Uint8ClampedArray(8);
    assert.equal(countDiff(a, b, 0.1, mark), 1);
    assert.deepEqual([...mark.slice(0, 4)], [255, 0, 255, 255]);
    assert.equal(mark[7], 255);
    assert.ok(mark[4] > 200);
  });

  it("pairs entries by name", () => {
    const p = pairEntries(
      [{ name: "a" }, { name: "b" }],
      [{ name: "b" }, { name: "c" }],
    );
    assert.deepEqual(p, { both: ["b"], added: ["c"], removed: ["a"] });
    assert.deepEqual(pairEntries(undefined, []), {
      both: [],
      added: [],
      removed: [],
    });
  });

  it("calls a picture changed above the tolerance, or on a size change", () => {
    const pairs = { both: ["a", "b", "c"], added: [], removed: [] };
    const s = summarize(
      [
        { name: "a", changed: 0, total: 1000 },
        { name: "b", changed: 5, total: 1000 },
        { name: "c", sizeMismatch: true, before: [1, 2], after: [3, 4] },
      ],
      pairs,
      0.001,
    );
    assert.deepEqual(
      s.rows.map((r) => r.different),
      [false, true, true],
    );
    assert.equal(s.anyChanged, true);
    assert.match(s.lines[2], /size changed 1x2 -> 3x4/);
    const clean = summarize(
      [{ name: "a", changed: 1, total: 100000 }],
      { both: ["a"], added: [], removed: [] },
      0.001,
    );
    assert.equal(clean.anyChanged, false);
  });

  it("a picture that is new or gone is a change", () => {
    const s = summarize([], { both: [], added: ["x"], removed: ["y"] }, 0.001);
    assert.equal(s.anyChanged, true);
    assert.deepEqual(s.lines, ["x: new", "y: missing from this run"]);
  });
});

describe("server.resolveRequest", () => {
  const root = path.resolve("/srv/dist");
  it("maps / to index.html and keeps files under the root", () => {
    assert.equal(resolveRequest(root, "/"), path.join(root, "index.html"));
    assert.equal(
      resolveRequest(root, "/assets/a.js?x=1"),
      path.join(root, "assets", "a.js"),
    );
  });
  it("refuses a path that leaves the root", () => {
    assert.equal(resolveRequest(root, "/../secret"), undefined);
    assert.equal(resolveRequest(root, "/%2e%2e/secret"), undefined);
    assert.equal(resolveRequest(root, "/a%00b"), undefined);
    assert.equal(resolveRequest(root, "/%E0%A4%A"), undefined);
  });
});

describe("chooseBrowser", () => {
  it("auto prefers playwright's chromium, then Edge, then Chrome", () => {
    const has = (set) => (p) => set.includes(p);
    const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
    const c = chooseBrowser("auto", {
      exists: has(["/pw/chrome", edge]),
      playwrightExecutable: () => "/pw/chrome",
    });
    assert.deepEqual(c, { kind: "chromium", executablePath: "/pw/chrome" });
    const e = chooseBrowser("auto", {
      exists: has([edge]),
      playwrightExecutable: () => "/pw/missing",
    });
    assert.equal(e.kind, "edge");
  });

  it("an explicit choice does not fall back, and the error says what was tried", () => {
    assert.throws(
      () =>
        chooseBrowser("chrome", {
          exists: () => false,
          playwrightExecutable: () => "/pw/chrome",
        }),
      /No browser found.*chrome/s,
    );
  });
});
