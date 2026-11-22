// Walks the journeys of walk.mjs through the real <App/>: serves the built
// harness, starts each journey on the chat page (fixture walk-start) and does
// each intent as the layout map says, with real clicks and key presses. What
// the page did is read from the page (harness/walkMock.ts keeps the messages).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chooseBrowser } from "./browser.mjs";
import { serve } from "./server.mjs";
import { launchOptions } from "./shoot.mjs";
import {
  actionsFor,
  bringIntoView,
  describeTarget,
  fillIn,
  findPlaceholders,
  measureControl,
  resolveTarget,
  settle,
  STEP_KINDS,
  summarize,
  WALK_HEIGHT,
  WalkError,
} from "./walk.mjs";

/** How long the page gets to show a control before the layout is called different. */
const FIND_MS = 5000;

function locate(page, target) {
  const base = target.within ? locate(page, target.within) : page;
  if (target.testId) return base.getByTestId(target.testId);
  if (target.role) {
    return base.getByRole(
      target.role,
      target.name ? { name: target.name, exact: true } : {},
    );
  }
  if (target.label) return base.getByLabel(target.label, { exact: true });
  if (target.text) return base.getByText(target.text);
  if (target.css) return base.locator(target.css);
  throw new WalkError(`a target needs testId, role, label, text or css`);
}

const walkLog = (page) => page.evaluate(() => window.__walk.log);
// The words in the page. A tooltip that opens under the pointer is not the
// page answering, and neither is a blank line.
const pageText = (page) =>
  page.evaluate(() => {
    let text = document.body.innerText;
    for (const tip of document.querySelectorAll('[role="tooltip"]')) {
      text = text.replace(tip.innerText, "");
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  });

/** One action of the map. Returns its trace entry; throws WalkError naming the intent. */
async function act(page, action, intent, journey) {
  const where = `${journey.id}: cannot "${intent}"`;
  const fix = "The layout differs from src/walkLayout.mjs: update the map.";
  const entry = { intent, do: action.do };
  if (action.do === "ide") {
    await page.evaluate(
      ([type, data]) => window.__walk.ide(type, data),
      [action.message, action.data],
    );
    await page.evaluate(settle);
    return {
      ...entry,
      target: `editor: ${action.message}`,
      scrollPx: 0,
      pageChanged: true,
    };
  }
  const target = resolveTarget(action.target, journey.inputs);
  const said = describeTarget(target);
  const found = locate(page, target);
  if (action.do === "gone") {
    try {
      await found.waitFor({ state: "detached", timeout: FIND_MS });
    } catch {
      throw new WalkError(`${where}: ${said} is still in the page. ${fix}`);
    }
    await page.evaluate(settle);
    return { ...entry, target: said, scrollPx: 0, pageChanged: true };
  }
  try {
    await found.first().waitFor({ state: "visible", timeout: FIND_MS });
  } catch {
    throw new WalkError(`${where}: no ${said} in the page. ${fix}`);
  }
  await page.evaluate(settle);
  const count = await found.count();
  if (count !== 1) {
    throw new WalkError(
      `${where}: ${said} matches ${count} elements. Make the map say which.`,
    );
  }
  const { value, ...measured } = await found.evaluate(measureControl);
  Object.assign(entry, { target: said }, measured);
  entry.scrollPx = await found.evaluate(bringIntoView);
  // Read at rest, just before the action, so only the action can change it
  const text = await pageText(page);
  if (action.do === "fill") entry.valuePlaceholders = findPlaceholders(value);
  if (action.do === "check" && (await found.isChecked())) {
    // already ticked: the person reads it and moves on
    entry.skipped = true;
  } else if (STEP_KINDS.has(action.do)) {
    const typed = fillIn(action.value, journey.inputs);
    try {
      if (action.do === "click") await found.click({ timeout: FIND_MS });
      if (action.do === "check") await found.check({ timeout: FIND_MS });
      if (action.do === "fill") await found.fill(typed, { timeout: FIND_MS });
      if (action.do === "select") {
        await found.selectOption(typed, { timeout: FIND_MS });
      }
      if (action.do === "press") {
        await found.press(action.key, { timeout: FIND_MS });
      }
    } catch (e) {
      throw new WalkError(
        `${where}: ${said} is there but could not be used (${String(e.message).split("\n")[0]}). ${fix}`,
      );
    }
  } else if (action.do !== "see") {
    throw new WalkError(
      `${where}: the map has an unknown action "${action.do}"`,
    );
  }
  await page.evaluate(settle);
  entry.pageChanged = (await pageText(page)) !== text;
  return entry;
}

/** One journey in a fresh page. A layout that cannot do it gives endsIn "failed" with the reason. */
async function walkOne(browser, url, journey, layout, width) {
  const context = await browser.newContext({
    viewport: { width, height: WALK_HEIGHT },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const trace = [];
  let files = [];
  let unanswered = [];
  let endsIn = "page";
  let error;
  try {
    const page = await context.newPage();
    await page.goto(`${url}?fixture=walk-start&theme=dark`, {
      waitUntil: "load",
    });
    await page.waitForFunction(() => window.__shotReady === true, null, {
      timeout: 30_000,
    });
    const harnessError = await page.evaluate(() => window.__shotError);
    if (harnessError)
      throw new Error(`harness: ${harnessError.split("\n")[0]}`);
    try {
      for (const intent of journey.intents) {
        const actions = actionsFor(layout, intent, journey.id);
        if (actions === null) {
          if (files.length === 0) {
            throw new WalkError(
              `${journey.id}: the layout map says "${intent}" cannot be done in the page, and no file was opened before it.`,
            );
          }
          endsIn = "file";
          break;
        }
        for (const action of actions) {
          trace.push(await act(page, action, intent, journey));
          files = (await walkLog(page)).files;
        }
      }
    } catch (e) {
      if (!(e instanceof WalkError)) throw e;
      endsIn = "failed";
      error = e.message;
    }
    ({ files, unanswered } = await walkLog(page));
  } finally {
    await context.close();
  }
  return {
    ...summarize({ journey, width, trace, files, endsIn, error }),
    // Requests the mock had no answer for; a new layout may need one in harness/walkMock.ts
    unanswered: [...new Set(unanswered)],
  };
}

/**
 * @param {object} o
 * @param {string} o.dist built harness folder
 * @param {string} o.playwrightDir folder of playwright-core (index.mjs)
 * @param {string} o.browser auto|chromium|edge|chrome
 * @param {Array} o.journeys from walk.mjs
 * @param {object} o.layout from walkLayout.mjs
 * @param {number[]} o.widths
 * @returns {Promise<{ browser: object, results: Array }>} one result per journey and width
 */
export async function walk(o) {
  const entry = path.join(o.playwrightDir, "index.mjs");
  const chromium = (await import(pathToFileURL(entry).href)).chromium;
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
  let browser;
  try {
    browser = await chromium.launch(launchOptions(choice));
    const results = [];
    for (const journey of o.journeys) {
      for (const width of o.widths) {
        const r = await walkOne(browser, server.url, journey, o.layout, width);
        console.error(
          `${journey.id}  ${width}  ${r.endsIn}${r.error ? `  ${r.error}` : ""}`,
        );
        results.push(r);
      }
    }
    return {
      browser: { kind: choice.kind, version: browser.version() },
      results,
    };
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}
