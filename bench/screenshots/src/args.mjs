// Command line parsing for screenshot.mjs. No dependency.
import {
  DEFAULTS,
  parseThemes,
  parseViews,
  parseWidths,
  planJobs,
} from "./views.mjs";

export const USAGE = `Usage: node bench/screenshots/screenshot.mjs [options]

  --view <names|all>     chat, conversation, streaming, tool-call, approval, tool-call-done,
                         loop, settings-tools, permissions-editor (comma list; default all)
  --width <px,px>        viewport widths (default 300,800)
  --height <px>          viewport height (default 700)
  --theme <dark|light|hc|both>   (default both = dark,light; hc is opt-in)
  --out <dir>            where the PNGs and manifest.json go (required)
  --diff <dir>           compare with an earlier run's folder; writes diff-*.png
                         for pictures that changed and exits 1 if any did
  --threshold <0..1>     per-pixel colour distance that counts as changed (0.1)
  --tolerance <0..1>     share of changed pixels a picture may have (0.001)
  --dist <dir>           use an already built harness instead of building one
  --browser <auto|chromium|edge|chrome>  (default auto)
  --sandbox              take the pictures inside a Windows Sandbox (see README)
  --list                 print the views and exit
  --help
`;

const VALUE_FLAGS = new Set([
  "view",
  "width",
  "height",
  "theme",
  "out",
  "diff",
  "threshold",
  "tolerance",
  "dist",
  "browser",
]);
const BOOL_FLAGS = new Set(["sandbox", "list", "help"]);

function number(name, value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`--${name} takes a number from ${min} to ${max}`);
  }
  return n;
}

/** Parses argv (without node and the script) into options; throws on a mistake. */
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) {
      raw[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`--${name} needs a value`);
      }
      raw[name] = v;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  if (raw.help || raw.list) return { help: !!raw.help, list: !!raw.list };
  if (!raw.out) throw new Error("--out <dir> is required");
  const browser = raw.browser ?? "auto";
  if (!["auto", "chromium", "edge", "chrome"].includes(browser)) {
    throw new Error("--browser takes auto, chromium, edge or chrome");
  }
  const height =
    raw.height === undefined
      ? DEFAULTS.height
      : number("height", raw.height, 200, 4000);
  const views = parseViews(raw.view);
  const widths = parseWidths(raw.width);
  const themes = parseThemes(raw.theme);
  return {
    out: raw.out,
    diff: raw.diff,
    dist: raw.dist,
    browser,
    sandbox: !!raw.sandbox,
    threshold: number("threshold", raw.threshold ?? "0.1", 0, 1),
    tolerance: number("tolerance", raw.tolerance ?? "0.001", 0, 1),
    jobs: planJobs({ views, widths, themes, height }),
  };
}
