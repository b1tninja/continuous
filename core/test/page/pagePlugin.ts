import { isBuiltin } from "node:module";
import path from "node:path";

// The few fields of a Vite plugin this uses, written out: the type checks of
// the extension and the CLI compile this file without Vite installed.
export interface PagePlugin {
  name: string;
  enforce: "pre";
  resolveId(source: string): string | null;
  load(id: string): string | null;
  transform(code: string, id: string): { code: string; map: null } | null;
}

// Makes the core sources the chat webview bundles run as they do in the built
// page (measured on the build, Vite 8):
//
// - every Node built-in is one empty CommonJS module (`module.exports = {}`),
//   so a named import is undefined and a default import is `{}`;
// - `process.env.NODE_ENV` is the string "production" and `process.env` is
//   `{}`: Vite replaces both in the text;
// - there is no `process`, `Buffer`, `global`, `require`, `__dirname`,
//   `__filename` or `setImmediate`.
//
// Only the files in `pageFiles` are changed. A test file is never one of them,
// so it keeps the real `fs`, `path` and `process` for its fixtures.

export const STUB_ID = "virtual:webview-node-stub";
const RESOLVED_STUB_ID = "\0" + STUB_ID;

/** Names a browser page does not have and Node (or vitest) does. */
export const MISSING_GLOBALS = [
  "process",
  "Buffer",
  "global",
  "require",
  "__dirname",
  "__filename",
  "setImmediate",
  "clearImmediate",
];

const IMPORT_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;
const NODE_ENV =
  /(?<![\w$.])(?:globalThis\.|global\.)?process\.env\.NODE_ENV\b/g;
const PROCESS_ENV = /(?<![\w$.])(?:globalThis\.|global\.)?process\.env\b/g;

/** True when the file itself declares or imports `name`. */
function declares(code: string, name: string): boolean {
  return (
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(
      code,
    ) ||
    new RegExp(`\\bimport\\b[^;'"]*\\b${name}\\b[^;'"]*\\bfrom\\b`).test(code)
  );
}

/**
 * The source of one bundled file as the page runs it. Lines keep their numbers:
 * what is added goes in front of the first line.
 */
export function asInThePage(code: string, file: string): string {
  let out = code
    .replace(NODE_ENV, '"production"')
    .replace(PROCESS_ENV, "({})")
    .replace(IMPORT_SPECIFIER, (all, lead, quote, specifier) =>
      isBuiltin(specifier) ? `${lead}${quote}${STUB_ID}${quote}` : all,
    );

  const missing = MISSING_GLOBALS.filter((name) => !declares(out, name));

  // A local `undefined` stands in for a name that does not exist. `typeof x`
  // gives "undefined" as in the page, and reading a property of it throws
  // (a TypeError here, a ReferenceError there). The one case that differs is
  // `x?.y`: undefined here, a ReferenceError in the page. So that is refused.
  for (const name of missing) {
    const optional = new RegExp(`(?<![\\w$.])${name}\\?\\.`).exec(out);
    if (optional) {
      const line = out.slice(0, optional.index).split("\n").length;
      throw new Error(
        `${file}:${line} reads \`${name}?.\`. The chat webview has no \`${name}\`, and \`?.\` does not guard a name that is not declared: use \`typeof ${name} !== "undefined"\`.`,
      );
    }
  }
  if (missing.length) {
    out = `const ${missing.map((n) => `${n} = undefined`).join(", ")}; ${out}`;
  }
  return out;
}

const slash = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/**
 * `pageFiles` are paths from the repository root (`core/util/uri.ts`);
 * `root` is the repository root.
 */
export function pagePlugin(pageFiles: string[], root: string): PagePlugin {
  const inPage = new Set(pageFiles.map((f) => slash(path.resolve(root, f))));
  return {
    name: "webview-page",
    enforce: "pre",
    resolveId(source: string) {
      return source === STUB_ID ? RESOLVED_STUB_ID : null;
    },
    load(id: string) {
      return id === RESOLVED_STUB_ID ? "export default {};" : null;
    },
    transform(code: string, id: string) {
      const file = id.replace(/[?#].*$/, "");
      if (!inPage.has(slash(file))) return null;
      return { code: asInThePage(code, file), map: null };
    },
  };
}
