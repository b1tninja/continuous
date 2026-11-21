import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compare,
  message,
  ownPairs,
  parseStubs,
  relativeImporter,
  stripAnsi,
} from "./check-webview-node-imports.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "check-webview-node-imports.mjs");
const WIN_ROOT = "C:/github/b1tninja/continuous";
const LINUX_ROOT = "/home/runner/work/continuous/continuous";

const warn = (mod, file) =>
  `[plugin rolldown:vite-resolve] Module "${mod}" has been externalized for browser compatibility, imported by "${file}". See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility`;

describe("stripAnsi", () => {
  it("removes colour codes and leaves text alone", () => {
    assert.equal(stripAnsi("\u001b[33mwarn\u001b[39m x"), "warn x");
    assert.equal(stripAnsi("plain"), "plain");
    assert.equal(stripAnsi(""), "");
  });
});

describe("relativeImporter", () => {
  it("makes a Windows path relative to the repository root", () => {
    assert.equal(
      relativeImporter(
        "C:\\github\\b1tninja\\continuous\\core\\util\\uri.ts",
        WIN_ROOT,
      ),
      "core/util/uri.ts",
    );
    assert.equal(
      relativeImporter(
        "C:/github/b1tninja/continuous/core/util/uri.ts",
        WIN_ROOT,
      ),
      "core/util/uri.ts",
    );
  });
  it("makes a Linux path relative to the root", () => {
    assert.equal(
      relativeImporter(`${LINUX_ROOT}/core/util/uri.ts`, LINUX_ROOT),
      "core/util/uri.ts",
    );
  });
  it("ignores drive-letter case and a trailing slash on the root", () => {
    assert.equal(
      relativeImporter(
        "c:/github/b1tninja/continuous/gui/a.ts",
        "C:/github/b1tninja/continuous/",
      ),
      "gui/a.ts",
    );
  });
  it("keeps a path outside the root as it is (with forward slashes)", () => {
    assert.equal(
      relativeImporter("D:\\elsewhere\\x.js", WIN_ROOT),
      "D:/elsewhere/x.js",
    );
  });
  it("does not treat a sibling folder that shares a prefix as inside the root", () => {
    assert.equal(
      relativeImporter("C:/github/b1tninja/continuous-other/x.ts", WIN_ROOT),
      "C:/github/b1tninja/continuous-other/x.ts",
    );
  });
});

describe("parseStubs", () => {
  it("reads the module and the importer from a warning", () => {
    const log = warn("node:path", `${WIN_ROOT}/core/util/ideUtils.ts`);
    assert.deepEqual(parseStubs(log, WIN_ROOT), [
      { module: "node:path", importer: "core/util/ideUtils.ts" },
    ]);
  });
  it("reads many, ignores other lines, and de-duplicates", () => {
    const log = [
      "vite v8 building for production...",
      warn("node:fs", `${WIN_ROOT}/core/a.ts`),
      "some other warning",
      warn("node:fs", `${WIN_ROOT}/core/a.ts`),
      warn("node:os", `${WIN_ROOT}/core/a.ts`),
      "✓ built in 5s",
    ].join("\n");
    assert.deepEqual(parseStubs(log, WIN_ROOT), [
      { module: "node:fs", importer: "core/a.ts" },
      { module: "node:os", importer: "core/a.ts" },
    ]);
  });
  it("sorts by importer, then module, so the baseline does not move around", () => {
    const log = [
      warn("node:path", `${WIN_ROOT}/z.ts`),
      warn("node:os", `${WIN_ROOT}/a.ts`),
      warn("node:fs", `${WIN_ROOT}/a.ts`),
    ].join("\n");
    assert.deepEqual(
      parseStubs(log, WIN_ROOT).map((p) => `${p.importer} ${p.module}`),
      ["a.ts node:fs", "a.ts node:os", "z.ts node:path"],
    );
  });
  it("reads a coloured log", () => {
    const log = `\u001b[33m${warn("node:fs", `${WIN_ROOT}/core/a.ts`)}\u001b[39m`;
    assert.equal(parseStubs(log, WIN_ROOT).length, 1);
  });
  it("gives the same pairs for a Windows build and a Linux build", () => {
    const win = parseStubs(
      warn("node:path", `${WIN_ROOT}/core/u.ts`),
      WIN_ROOT,
    );
    const linux = parseStubs(
      warn("node:path", `${LINUX_ROOT}/core/u.ts`),
      LINUX_ROOT,
    );
    assert.deepEqual(win, linux);
  });
  it("is empty for a log with no warnings", () => {
    assert.deepEqual(parseStubs("✓ built in 5s", WIN_ROOT), []);
    assert.deepEqual(parseStubs("", WIN_ROOT), []);
  });
});

describe("ownPairs", () => {
  it("keeps our sources and drops dependencies under node_modules", () => {
    const pairs = [
      { module: "node:fs", importer: "core/a.ts" },
      {
        module: "node:http",
        importer: "packages/fetch/node_modules/fetch-blob/from.js",
      },
      { module: "node:net", importer: "node_modules/x/index.js" },
      { module: "node:tls", importer: "packages/fetch/dist/certs.js" },
    ];
    assert.deepEqual(
      ownPairs(pairs).map((p) => p.importer),
      ["core/a.ts", "packages/fetch/dist/certs.js"],
    );
  });
  it("does not drop a file only because its name contains node_modules", () => {
    const pairs = [
      { module: "node:fs", importer: "core/my_node_modules_notes.ts" },
    ];
    assert.equal(ownPairs(pairs).length, 1);
  });
});

describe("compare", () => {
  const a = { module: "node:fs", importer: "core/a.ts" };
  const b = { module: "node:path", importer: "core/b.ts" };
  it("nothing new, nothing gone", () => {
    assert.deepEqual(compare([a, b], [b, a]), { added: [], removed: [] });
  });
  it("a new pair is added", () => {
    assert.deepEqual(compare([a, b], [a]), { added: [b], removed: [] });
  });
  it("a pair that is gone is reported as removed", () => {
    assert.deepEqual(compare([a], [a, b]), { added: [], removed: [b] });
  });
  it("the same file with a different module is new", () => {
    const c = { module: "node:os", importer: "core/a.ts" };
    assert.deepEqual(compare([a, c], [a]), { added: [c], removed: [] });
  });
  it("the same module in a different file is new", () => {
    const c = { module: "node:fs", importer: "core/c.ts" };
    assert.deepEqual(compare([a, c], [a]), { added: [c], removed: [] });
  });
  it("empty on both sides", () => {
    assert.deepEqual(compare([], []), { added: [], removed: [] });
  });
});

describe("message", () => {
  it("names each pair and says what to do", () => {
    const text = message([{ module: "node:path", importer: "core/x.ts" }]);
    assert.match(text, /node:path\s+imported by\s+core\/x\.ts/);
    assert.match(text, /baseline\.json/);
    assert.match(text, /throws at run time/);
  });
});

describe("the command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webview-check-"));
  const run = (log, ...flags) => {
    const file = path.join(dir, "build.log");
    fs.writeFileSync(file, log);
    return spawnSync(process.execPath, [SCRIPT, "--log", file, ...flags], {
      encoding: "utf8",
    });
  };
  const baseline = JSON.parse(
    fs.readFileSync(
      path.join(HERE, "webview-node-imports.baseline.json"),
      "utf8",
    ),
  ).pairs;
  const ROOT = path.resolve(HERE, "..", "..").replace(/\\/g, "/");
  const logOf = (pairs, extra = []) =>
    [
      ...pairs.map((p) => warn(p.module, `${ROOT}/${p.importer}`)),
      ...extra,
    ].join("\n");

  it("passes when the build matches the baseline", () => {
    const r = run(logOf(baseline));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /none new/);
  });

  it("fails when a file starts importing a new Node module", () => {
    const r = run(
      logOf(baseline, [warn("node:path", `${ROOT}/core/util/somethingNew.ts`)]),
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /core\/util\/somethingNew\.ts/);
    assert.match(r.stderr, /node:path/);
  });

  it("does not fail for a dependency's stub", () => {
    const r = run(
      logOf(baseline, [
        warn("node:http", `${ROOT}/node_modules/some-lib/index.js`),
      ]),
    );
    assert.equal(r.status, 0, r.stderr);
  });

  it("reports a baseline pair that is gone, and still passes", () => {
    const r = run(logOf(baseline.slice(1)));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gone from the build/);
  });

  it("is an error, not a pass, when the log has no warnings at all", () => {
    const r = run("✓ built in 5s\n");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /No stub warnings/);
  });

  it("the baseline lists only our own sources, sorted, with no duplicates", () => {
    const keys = baseline.map((p) => `${p.importer}\u0000${p.module}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(
      keys,
      [...keys].sort((x, y) => x.localeCompare(y)),
    );
    for (const p of baseline)
      assert.ok(!p.importer.includes("node_modules"), p.importer);
  });

  it("the baseline does not list ideUtils.ts, whose path import was removed", () => {
    assert.ok(!baseline.some((p) => p.importer === "core/util/ideUtils.ts"));
  });
});
