import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  BASELINE_FILE,
  compare,
  covers,
  failures,
  message,
  relativeTo,
  thrownAt,
} from "./page-tests.mjs";
import {
  coreSource,
  coreSources,
  siblingSuites,
} from "./webview-page-graph.mjs";

const WIN_ROOT = "C:/github/b1tninja/continuous";
const LINUX_ROOT = "/home/runner/work/continuous/continuous";
const PAGE = new Set(["core/util/ideUtils.ts", "core/util/uri.ts"]);

describe("coreSource", () => {
  it("makes a module id a path under core/", () => {
    assert.equal(
      coreSource(
        "C:\\github\\b1tninja\\continuous\\core\\util\\uri.ts",
        `${WIN_ROOT}/core`,
      ),
      "core/util/uri.ts",
    );
    assert.equal(
      coreSource(`${LINUX_ROOT}/core/util/uri.ts`, `${LINUX_ROOT}/core/`),
      "core/util/uri.ts",
    );
  });
  it("drops a query, as on an asset import", () => {
    assert.equal(
      coreSource(`${LINUX_ROOT}/core/a.ts?raw`, `${LINUX_ROOT}/core`),
      "core/a.ts",
    );
  });
  it("is undefined for a dependency, another folder, and a file that is not code", () => {
    const core = `${LINUX_ROOT}/core`;
    assert.equal(
      coreSource(`${core}/node_modules/zod/index.js`, core),
      undefined,
    );
    assert.equal(coreSource(`${LINUX_ROOT}/gui/src/main.tsx`, core), undefined);
    assert.equal(coreSource(`${LINUX_ROOT}/core-other/a.ts`, core), undefined);
    assert.equal(coreSource(`${core}/llm/models.json`, core), undefined);
    assert.equal(coreSource("\0vite/preload-helper.js", core), undefined);
  });
  it("takes core from where the build found it, which a linked checkout moves", () => {
    assert.equal(
      coreSource("D:/main/core/util/uri.ts", "D:\\main\\core"),
      "core/util/uri.ts",
    );
  });
});

describe("coreSources", () => {
  it("sorts and de-duplicates", () => {
    const core = `${LINUX_ROOT}/core`;
    assert.deepEqual(
      coreSources(
        [`${core}/b.ts`, `${core}/a.ts`, `${core}/b.ts`, "x/y.js"],
        core,
      ),
      ["core/a.ts", "core/b.ts"],
    );
  });
});

describe("siblingSuites", () => {
  it("finds a.vitest.ts and a.<name>.vitest.ts beside a bundled a.ts, and nothing else", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-suites-"));
    try {
      fs.mkdirSync(path.join(root, "core", "util"), { recursive: true });
      for (const name of [
        "a.ts",
        "a.vitest.ts",
        "a.windows.vitest.ts",
        "a.test.ts",
        "ab.vitest.ts",
        "b.ts",
        "c.vitest.ts",
      ]) {
        fs.writeFileSync(path.join(root, "core", "util", name), "");
      }
      assert.deepEqual(
        siblingSuites(
          ["core/util/a.ts", "core/util/b.ts", "core/gone/x.ts"],
          root,
        ),
        ["core/util/a.vitest.ts", "core/util/a.windows.vitest.ts"],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relativeTo", () => {
  it("is a path from the root, or undefined outside it", () => {
    assert.equal(relativeTo(`${WIN_ROOT}\\core\\a.ts`, WIN_ROOT), "core/a.ts");
    assert.equal(
      relativeTo(`${LINUX_ROOT}/core/a.ts`, LINUX_ROOT),
      "core/a.ts",
    );
    assert.equal(relativeTo("/elsewhere/a.ts", LINUX_ROOT), undefined);
  });
});

describe("thrownAt", () => {
  it("names the innermost frame in a bundled file", () => {
    const text = [
      "TypeError: Cannot read properties of undefined (reading 'relative')",
      `    at windowsInside (${WIN_ROOT}/core/util/ideUtils.ts:40:22)`,
      `    at staysInDir (${WIN_ROOT}/core/util/ideUtils.ts:61:10)`,
      `    at ${WIN_ROOT}/core/util/ideUtils.vitest.ts:12:5`,
    ].join("\n");
    assert.equal(
      thrownAt(text, WIN_ROOT, PAGE),
      "core/util/ideUtils.ts#windowsInside",
    );
  });
  it("skips frames in dependencies and in files the page does not bundle", () => {
    const text = [
      "TypeError: x",
      `    at parse (${LINUX_ROOT}/core/node_modules/uri-js/dist/uri.js:1:1)`,
      `    at helper (${LINUX_ROOT}/core/util/nodeOnly.ts:3:1)`,
      `    at Object.findUriInDirs (${LINUX_ROOT}/core/util/uri.ts:95:5)`,
    ].join("\n");
    assert.equal(
      thrownAt(text, LINUX_ROOT, PAGE),
      "core/util/uri.ts#findUriInDirs",
    );
  });
  it("reads an async frame, a file URL, and code outside a function", () => {
    assert.equal(
      thrownAt(
        `E\n    at async load (file:///${WIN_ROOT}/core/util/uri.ts:1:1)`,
        WIN_ROOT,
        PAGE,
      ),
      "core/util/uri.ts#load",
    );
    assert.equal(
      thrownAt(
        `E\n    at ${LINUX_ROOT}/core/util/uri.ts:1:1`,
        LINUX_ROOT,
        PAGE,
      ),
      "core/util/uri.ts",
    );
  });
  it("is undefined for an assertion that failed in the test itself", () => {
    const text = `AssertionError: expected 1 to be 2\n    at ${LINUX_ROOT}/core/util/uri.vitest.ts:9:3`;
    assert.equal(thrownAt(text, LINUX_ROOT, PAGE), undefined);
  });
});

describe("failures", () => {
  const report = {
    testResults: [
      {
        name: `${WIN_ROOT}\\core\\util\\uri.vitest.ts`,
        status: "failed",
        assertionResults: [
          { fullName: "uri ok", status: "passed", failureMessages: [] },
          {
            fullName: "uri folds case",
            status: "failed",
            failureMessages: [
              `TypeError: boom\n    at findUriInDirs (${WIN_ROOT}/core/util/uri.ts:95:5)`,
            ],
          },
        ],
      },
      {
        name: `${WIN_ROOT}/core/util/broken.vitest.ts`,
        status: "failed",
        message: "Buffer is not defined\nmore",
        assertionResults: [],
      },
      {
        name: `${WIN_ROOT}/core/util/fine.vitest.ts`,
        status: "passed",
        assertionResults: [
          { fullName: "fine", status: "passed", failureMessages: [] },
        ],
      },
    ],
  };
  it("lists failed tests, and a suite that failed before any test ran", () => {
    assert.deepEqual(failures(report, WIN_ROOT, PAGE), [
      {
        suite: "core/util/uri.vitest.ts",
        test: "uri folds case",
        where: "core/util/uri.ts#findUriInDirs",
        message: "TypeError: boom",
      },
      {
        suite: "core/util/broken.vitest.ts",
        where: undefined,
        message: "Buffer is not defined",
      },
    ]);
  });
  it("is empty for an empty report", () => {
    assert.deepEqual(failures({}, WIN_ROOT, PAGE), []);
  });
});

describe("covers and compare", () => {
  const thrown = {
    suite: "core/a.vitest.ts",
    test: "a throws",
    where: "core/a.ts#f",
  };
  const differs = { suite: "core/a.vitest.ts", test: "a differs" };
  const whole = { suite: "core/b.vitest.ts", where: undefined };

  it("a place covers any test that throws there, in any suite", () => {
    assert.equal(covers({ where: "core/a.ts#f" }, thrown), true);
    assert.equal(covers({ where: "core/a.ts#g" }, thrown), false);
    assert.equal(covers({ where: "core/a.ts#f" }, differs), false);
  });
  it("a suite and test covers that test only", () => {
    const entry = { suite: "core/a.vitest.ts", test: "a differs" };
    assert.equal(covers(entry, differs), true);
    assert.equal(covers(entry, thrown), false);
    assert.equal(
      covers({ ...entry, suite: "core/b.vitest.ts" }, differs),
      false,
    );
  });
  it("a suite alone covers everything in it", () => {
    assert.equal(covers({ suite: "core/b.vitest.ts" }, whole), true);
    assert.equal(covers({ suite: "core/a.vitest.ts" }, thrown), true);
    assert.equal(covers({ suite: "core/a.vitest.ts" }, whole), false);
  });
  it("reports what is new and what the baseline no longer needs", () => {
    const baseline = [{ where: "core/a.ts#f" }, { where: "core/gone.ts#g" }];
    const { added, unused } = compare([thrown, differs], baseline);
    assert.deepEqual(added, [differs]);
    assert.deepEqual(unused, [{ where: "core/gone.ts#g" }]);
  });
  it("is clean when everything is known", () => {
    assert.deepEqual(compare([thrown], [{ where: "core/a.ts#f" }]), {
      added: [],
      unused: [],
    });
  });
});

describe("message", () => {
  it("names the suite, the test, and the bundled file that threw", () => {
    const text = message([
      {
        suite: "core/util/ideUtils.vitest.ts",
        test: "stays in dir",
        where: "core/util/ideUtils.ts#windowsInside",
        message: "TypeError: Cannot read properties of undefined",
      },
    ]);
    assert.match(text, /core\/util\/ideUtils\.vitest\.ts > stays in dir/);
    assert.match(text, /thrown at core\/util\/ideUtils\.ts#windowsInside/);
    assert.match(text, /page-tests\.baseline\.json/);
  });
});

describe("the baseline file", () => {
  const { entries } = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  it("gives every entry a kind and a reason", () => {
    for (const e of entries) {
      assert.ok(e.where || e.suite, JSON.stringify(e));
      assert.match(e.kind, /^(not-reached|no-environment|bug)$/);
      assert.ok(e.why && e.why.length > 5, JSON.stringify(e));
    }
  });
  it("names files that exist", () => {
    const root = path.resolve(path.dirname(BASELINE_FILE), "..", "..");
    for (const e of entries) {
      const file = (e.where ?? e.suite).replace(/#.*$/, "");
      assert.ok(fs.existsSync(path.join(root, file)), file);
    }
  });
});
