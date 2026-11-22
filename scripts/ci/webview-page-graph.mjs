#!/usr/bin/env node
// The source files of core/ that the chat webview's build bundles, read from
// the build itself: every module id Vite loaded for gui's two pages, kept when
// it is one of core's own sources.
//
// Usage:
//   node scripts/ci/webview-page-graph.mjs      print the list as JSON
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const GUI = path.join(ROOT, "gui");

const slash = (p) => p.replace(/\\/g, "/");

/**
 * A module id as a path under core/ with forward slashes, or undefined when it
 * is not one of core's own sources. `coreDir` is where the build found core.
 */
export function coreSource(id, coreDir) {
  const file = slash(id).replace(/[?#].*$/, "");
  const dir = slash(coreDir).replace(/\/+$/, "");
  if (!file.toLowerCase().startsWith(dir.toLowerCase() + "/")) return undefined;
  const rel = file.slice(dir.length + 1);
  if (rel.split("/").includes("node_modules")) return undefined;
  return /\.(ts|tsx|js|mjs|cjs)$/.test(rel) ? `core/${rel}` : undefined;
}

/** Sorted, de-duplicated `core/...` paths from a list of module ids. */
export function coreSources(ids, coreDir) {
  const found = new Set();
  for (const id of ids) {
    const rel = coreSource(id, coreDir);
    if (rel) found.add(rel);
  }
  return [...found].sort();
}

/**
 * The vitest suites that sit beside those files: `a/b.vitest.ts` and
 * `a/b.<anything>.vitest.ts` for a bundled `a/b.ts`. Paths from `root`.
 */
export function siblingSuites(files, root = ROOT) {
  const suites = new Set();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, "") + ".";
    let names;
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(stem) && name.endsWith(".vitest.ts"))
        suites.add(`${dir}/${name}`);
    }
  }
  return [...suites].sort();
}

/** Builds the webview in memory and returns the `core/...` files it loaded. */
export async function pageCoreFiles() {
  const require = createRequire(path.join(GUI, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  let ids = [];
  // A build sets NODE_ENV to "production" for the whole process. Put it back,
  // or the tests a caller starts next inherit it.
  const nodeEnv = process.env.NODE_ENV;
  await build({
    root: GUI,
    logLevel: "silent",
    build: { write: false, sourcemap: false, minify: false },
    plugins: [
      {
        name: "record-module-ids",
        buildEnd() {
          ids = [...this.getModuleIds()];
        },
      },
    ],
  });
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  // gui imports core as the package `core`. The build reports real paths, so
  // ask where that package really is (a linked checkout can point elsewhere).
  const coreDir = fs.realpathSync(path.join(GUI, "node_modules", "core"));
  const files = coreSources(ids, coreDir);
  if (files.length === 0) {
    throw new Error(
      `The webview build loaded no file under ${coreDir}. The build may have changed; check scripts/ci/webview-page-graph.mjs.`,
    );
  }
  return files;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  pageCoreFiles().then(
    (files) => {
      process.stdout.write(JSON.stringify(files, null, 2) + "\n");
      // Vite's plugins can leave handles open after a build.
      process.exit(0);
    },
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
