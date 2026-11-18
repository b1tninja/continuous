#!/usr/bin/env node
// What a long chat costs in the webview: mount time, DOM size, heap, the time
// one streamed chunk takes to reach the screen, and scroll steps.
//
//   node bench/perf/webview-chat.mjs --out <file.json outside the repo> [--sizes 10,100,300,1000] [--browser edge]
//
// Uses the screenshot harness (bench/screenshots): the real <App/> and redux
// store with MockIdeMessenger in a headless browser. Needs `npm ci` in gui/
// and `npm ci --ignore-scripts` in bench/screenshots. No model, no IDE: the
// store is filled with a synthetic history and streamed into by dispatch.
//
// The harness bundle is not the production webview bundle (packages are read
// from source), so load times here are not the webview's; the per-message
// costs are the same components and the same reducers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { round, summarize } from "./src/stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outFile = flag("--out");
if (
  !outFile ||
  path.resolve(outFile).startsWith(repo + path.sep) ||
  path.resolve(outFile) === repo
) {
  console.error("Usage: webview-chat.mjs --out <file outside the repository>");
  process.exit(2);
}
const sizes = (flag("--sizes") ?? "10,100,300,1000").split(",").map(Number);
const shots = path.join(repo, "bench", "screenshots");
const load = (p) => import(pathToFileURL(path.join(shots, p)).href);
const { buildHarness, playwrightDir } = await load("src/build.mjs");
const { chooseBrowser } = await load("src/browser.mjs");
const { serve } = await load("src/server.mjs");
const { chromium } = await import(
  pathToFileURL(path.join(playwrightDir(), "index.mjs")).href
);

const dist = buildHarness();
const server = await serve(dist);
const choice = chooseBrowser(flag("--browser") ?? "auto", {
  playwrightExecutable: () => {
    try {
      return chromium.executablePath();
    } catch {
      return undefined;
    }
  },
});
const browser = await chromium.launch({
  headless: true,
  executablePath: choice.executablePath,
  args: [
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "--enable-precise-memory-info",
  ],
});
const results = {
  browser: browser.version(),
  date: new Date().toISOString(),
  sizes: [],
};

/** Runs in the page: fills the store with n messages, streams 40 chunks, scrolls. */
async function measure(n) {
  const reply = (i) =>
    [
      `Step ${i}: the failure is in \`parseConfig\`: it reads \`opts.timeout\` before the defaults are merged.`,
      "",
      "```ts",
      `export function parseConfig${i}(opts: Partial<Config> = {}) {`,
      "  const merged = { ...DEFAULTS, ...opts };",
      "  return { ...merged, timeout: merged.timeout * 1000 };",
      "}",
      "```",
      "",
      "- merge the defaults first",
      "- convert the unit last",
    ].join("\n");
  const item = (role, content, id) => ({
    message: { role, content, id },
    contextItems: [],
  });
  const history = [];
  for (let i = 0; history.length < n; i++) {
    history.push(
      item("user", `Question ${i}: why does test ${i} fail?`, `u${i}`),
    );
    history.push(item("assistant", reply(i), `a${i}`));
  }
  history.length = n;
  if (history[n - 1].message.role !== "assistant") {
    history[n - 1] = item("assistant", reply(n), "alast");
  }
  const store = window.__store;
  const frame = () =>
    new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
  const settle = async () => {
    for (let i = 0; i < 3; i++) await frame();
  };
  await settle();
  const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
  let t0 = performance.now();
  store.dispatch({
    type: "session/newSession",
    payload: {
      sessionId: "perf",
      title: "perf",
      workspaceDirectory: "file:///c:/work/app",
      history,
    },
  });
  await frame();
  const mountMs = performance.now() - t0;
  await new Promise((res) => setTimeout(res, 1500)); // effects: markdown, editors
  await settle();
  const domNodes = document.querySelectorAll("*").length;
  const editors = document.querySelectorAll(".ProseMirror").length;
  const heapAfter = performance.memory?.usedJSHeapSize ?? 0;

  store.dispatch({ type: "session/setActive" });
  await settle();
  const stream = [];
  for (let i = 0; i < 40; i++) {
    t0 = performance.now();
    store.dispatch({
      type: "session/streamUpdate",
      payload: [
        {
          role: "assistant",
          content: i % 10 === 9 ? ` and \`x${i}\`.\n\n` : ` word${i}`,
        },
      ],
    });
    await frame();
    stream.push(performance.now() - t0);
  }
  store.dispatch({ type: "session/setInactive" });
  await settle();

  const scroller = [...document.querySelectorAll("*")]
    .filter(
      (e) =>
        e.scrollHeight > e.clientHeight + 50 &&
        getComputedStyle(e).overflowY !== "visible",
    )
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  const scroll = [];
  if (scroller) {
    for (let i = 0; i < 20; i++) {
      t0 = performance.now();
      scroller.scrollTop = (scroller.scrollHeight * i) / 20;
      await frame();
      scroll.push(performance.now() - t0);
    }
  }
  return {
    rendered: store.getState().session.history.length,
    mountMs,
    domNodes,
    editors,
    heapDeltaMB: (heapAfter - heapBefore) / 1048576,
    stream,
    scroll,
  };
}

for (const n of sizes) {
  const context = await browser.newContext({
    viewport: { width: 400, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  await page.goto(`${server.url}?fixture=chat&theme=dark`, {
    waitUntil: "load",
  });
  await page.waitForFunction(() => window.__shotReady === true, null, {
    timeout: 30_000,
  });
  const r = await page.evaluate(measure, n);
  const stream = summarize(r.stream);
  const scroll = summarize(r.scroll);
  const row = {
    messages: n,
    rendered: r.rendered,
    mountMs: round(r.mountMs),
    domNodes: r.domNodes,
    editors: r.editors,
    heapDeltaMB: round(r.heapDeltaMB),
    streamChunkMs: {
      median: round(stream.median),
      p95: round(stream.p95),
      max: round(stream.max),
    },
    scrollStepMs: { median: round(scroll.median), p95: round(scroll.p95) },
    pageErrors: errors.length,
  };
  results.sizes.push(row);
  console.log(JSON.stringify(row));
  await context.close();
}
await browser.close();
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
try {
  fs.rmSync(dist, { recursive: true, force: true });
} catch {
  // the temp folder is the OS's to clean
}
process.exit(0);
