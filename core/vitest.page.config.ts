import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

import { siblingSuites } from "../scripts/ci/webview-page-graph.mjs";
import { pagePlugin } from "./test/page/pagePlugin";
import base from "./vitest.config";

// The "page" project: the suites of the core modules the chat webview bundles,
// run with those modules as the built page has them (no Node built-ins, no
// `process`, no `Buffer`; see test/page/pagePlugin.ts). Run it through
// `npm run test:page`, which compares the failures with the baseline; on its
// own this config reports every failure, baselined or not.

const ROOT = path.resolve(import.meta.dirname, "..");

/** The bundled core files: from WEBVIEW_PAGE_GRAPH if set, else from a build. */
function pageFiles(): string[] {
  const saved = process.env.WEBVIEW_PAGE_GRAPH;
  if (saved) return JSON.parse(fs.readFileSync(saved, "utf8"));
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "ci", "webview-page-graph.mjs")],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  );
  if (r.status !== 0) {
    throw new Error(`The webview build failed:\n${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

const files = pageFiles();

// A fixture that shows the plugin is working (test/page/canary.page.ts).
const CANARY = "core/test/page/canary.ts";

// Not mergeConfig: it would add these suites to the base `include`, not replace it.
export default defineConfig({
  plugins: [pagePlugin([...files, CANARY], ROOT)],
  test: {
    ...base.test,
    include: [
      "test/page/canary.page.ts",
      ...siblingSuites(files, ROOT).map((f) => f.replace(/^core\//, "")),
    ],
  },
});
