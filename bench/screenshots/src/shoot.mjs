// Takes the pictures: serves the built harness, drives a browser through
// playwright-core, writes PNGs and manifest.json. The same file runs on the
// host and inside the Windows Sandbox (sandbox-entry.mjs); it needs only Node,
// a vendored playwright-core and a browser.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chooseBrowser } from "./browser.mjs";
import { runAxe } from "./axe.mjs";
import { countDiff, pageCompare, pairEntries, summarize } from "./diff.mjs";
import { serve } from "./server.mjs";

async function loadPlaywright(playwrightDir) {
  const entry = path.join(playwrightDir, "index.mjs");
  return (await import(pathToFileURL(entry).href)).chromium;
}

export function launchOptions(choice) {
  return {
    headless: true,
    executablePath: choice.executablePath,
    // the GPU is not needed and is absent in the sandbox
    args: [
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
    ],
  };
}

/**
 * @param {object} o
 * @param {string} o.dist built harness folder
 * @param {string} o.out output folder
 * @param {Array} o.jobs from planJobs
 * @param {string} o.playwrightDir folder of playwright-core (index.mjs)
 * @param {string} o.browser auto|chromium|edge|chrome
 * @param {boolean} [o.axe] run axe-core after __shotReady and record violations per entry
 */
export async function shoot(o) {
  fs.mkdirSync(o.out, { recursive: true });
  const chromium = await loadPlaywright(o.playwrightDir);
  const choice = chooseBrowser(o.browser, {
    playwrightExecutable: () => {
      try {
        return chromium.executablePath();
      } catch {
        return undefined;
      }
    },
  });
  const server = await serve(o.dist);
  const t0 = Date.now();
  const entries = [];
  let browser;
  try {
    browser = await chromium.launch(launchOptions(choice));
    const version = browser.version();
    for (const job of o.jobs) {
      const t1 = Date.now();
      const context = await browser.newContext({
        viewport: { width: job.width, height: job.height },
        colorScheme: job.theme === "light" ? "light" : "dark",
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error")
          errors.push(`console: ${m.text().slice(0, 300)}`);
      });
      const url = `${server.url}?fixture=${encodeURIComponent(job.fixture)}&theme=${job.theme}`;
      await page.goto(url, { waitUntil: "load" });
      await page.waitForFunction(() => window.__shotReady === true, null, {
        timeout: 30_000,
      });
      const harnessError = await page.evaluate(() => window.__shotError);
      if (harnessError) errors.push(`harness: ${harnessError.split("\n")[0]}`);
      let axe;
      if (o.axe) {
        try {
          axe = await runAxe(page);
        } catch (e) {
          errors.push(`axe: ${String(e.message).split("\n")[0]}`);
        }
      }
      const file = path.join(o.out, job.name);
      await page.screenshot({
        path: file,
        animations: "disabled",
        caret: "hide",
      });
      await context.close();
      const bytes = fs.readFileSync(file);
      entries.push({
        name: job.name,
        view: job.view,
        fixture: job.fixture,
        width: job.width,
        height: job.height,
        theme: job.theme,
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        ms: Date.now() - t1,
        errors,
        ...(axe ? { axe } : {}),
      });
      console.error(
        `${job.name}  ${Date.now() - t1} ms${errors.length ? `  (${errors.length} errors, first: ${errors[0].slice(0, 120)})` : ""}`,
      );
    }
    const manifest = {
      tool: "bench/screenshots",
      takenAt: new Date().toISOString(),
      browser: { kind: choice.kind, version },
      totalMs: Date.now() - t0,
      entries,
    };
    fs.writeFileSync(
      path.join(o.out, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return manifest;
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}

/**
 * Compares the pictures in `o.out` with the ones in `o.diff` (an earlier run).
 * Writes diff-<name>.png next to the new pictures for each that differs.
 * Returns the summarize() result.
 */
export async function compareRuns(o) {
  const read = (dir) =>
    JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const before = read(o.diff);
  const after = read(o.out);
  const pairs = pairEntries(before.entries, after.entries);
  const chromium = await loadPlaywright(o.playwrightDir);
  const choice = chooseBrowser(o.browser, {
    playwrightExecutable: () => {
      try {
        return chromium.executablePath();
      } catch {
        return undefined;
      }
    },
  });
  const browser = await chromium.launch(launchOptions(choice));
  const results = [];
  try {
    const page = await browser.newPage();
    for (const name of pairs.both) {
      const a = fs.readFileSync(path.join(o.diff, name)).toString("base64");
      const b = fs.readFileSync(path.join(o.out, name)).toString("base64");
      const r = await page.evaluate(
        ([x, y, t, src]) => (0, eval)(`(${src.page})`)(x, y, t, src.count),
        [
          a,
          b,
          o.threshold,
          { page: pageCompare.toString(), count: countDiff.toString() },
        ],
      );
      results.push({ name, ...r });
      const share = r.sizeMismatch ? 1 : r.changed / r.total;
      if (r.diffPng && share > 0) {
        fs.writeFileSync(
          path.join(o.out, `diff-${name}`),
          Buffer.from(r.diffPng, "base64"),
        );
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const summary = summarize(
    results.map(({ diffPng, ...rest }) => rest),
    pairs,
    o.tolerance,
  );
  fs.writeFileSync(
    path.join(o.out, "diff.json"),
    JSON.stringify(
      {
        against: path.resolve(o.diff),
        tolerance: o.tolerance,
        threshold: o.threshold,
        rows: summary.rows,
      },
      null,
      2,
    ) + "\n",
  );
  return summary;
}
