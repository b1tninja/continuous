import fs from "node:fs";
import path from "node:path";

/** Directories whose non-test source ships in a product. Relative to the repo root. */
export const SCAN_ROOTS = [
  "core",
  "gui/src",
  "extensions/vscode/src",
  "extensions/cli/src",
  "packages",
  "binary/src",
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".git",
  "__mocks__",
  "__snapshots__",
  "test",
  "tests",
  "e2e",
  "test-helpers",
]);

const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.vitest\.|\.spec\.|\.d\.ts$)/;
const URL_HOST = /https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g;

export interface HostHit {
  host: string;
  file: string;
  line: number;
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walk(path.join(dir, entry.name));
      }
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

/**
 * Every `http(s)://host` literal in non-test source. Comment-only lines are
 * skipped. A host must contain a dot or be `localhost`, which drops
 * template pieces such as `http://${host}` and prose such as `http://h`.
 */
export function scanHosts(repoRoot: string): HostHit[] {
  const hits: HostHit[] = [];
  for (const root of SCAN_ROOTS) {
    const start = path.join(repoRoot, root);
    if (!fs.existsSync(start)) continue;
    for (const file of walk(start)) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        const t = text.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
          return;
        }
        for (const m of text.matchAll(URL_HOST)) {
          const host = m[1].toLowerCase().replace(/\.+$/, "");
          if (host.includes(".") || host === "localhost") {
            hits.push({ host, file: rel, line: i + 1 });
          }
        }
      });
    }
  }
  return hits;
}
