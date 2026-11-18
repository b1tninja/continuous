// Builds the screenshot harness (harness/index.html) into dist/ next to this
// file's caller-chosen --outDir. Dev-only: nothing in gui/, core/ or
// extensions/ imports this, and gui/vite.config.ts does not list the harness.
//
// The plugins and vite itself come from gui/node_modules (this folder has no
// dependencies of its own); the workspace packages are mapped to SOURCE so a
// stale build of core or packages/* cannot change what is drawn.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const gui = path.join(repo, "gui");
const fromGui = createRequire(path.join(gui, "package.json"));

async function plugin(name) {
  const mod = await import(pathToFileURL(fromGui.resolve(name)).href);
  return mod.default ?? mod;
}

/** One alias per packages/<name>/src/index.ts that exists. */
function workspacePackages() {
  const dir = path.join(repo, "packages");
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, entry: path.join(dir, name, "src", "index.ts") }))
    .filter((p) => fs.existsSync(p.entry))
    .map((p) => ({
      find: new RegExp(`^@continuedev/${p.name}$`),
      replacement: p.entry,
    }));
}

/**
 * core/util/paths.ts runs a migration of ~/.continue at import (os.homedir,
 * fs.cpSync). A browser has neither; the harness never reads the folder, so
 * the constant is fixed and the migration never runs.
 */
function skipGlobalDirMigration() {
  const marker = "const CONTINUE_GLOBAL_DIR = (() => {";
  return {
    name: "harness-skip-global-dir-migration",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("core/util/paths.ts")) return null;
      if (!code.includes(marker)) return null;
      return code.replace(
        marker,
        `const CONTINUE_GLOBAL_DIR = "/harness/.continue";
const _migration = (() => {
  if (true) return "";`,
      );
    },
  };
}

export default async function config() {
  const { defineConfig } = await import(
    pathToFileURL(fromGui.resolve("vite")).href
  );
  const react = await plugin("@vitejs/plugin-react-swc");
  const tailwindcss = await plugin("@tailwindcss/vite");
  const guiModules = path.join(gui, "node_modules");
  const dep = (name) => path.join(guiModules, name);
  return defineConfig({
    root: path.join(here, "harness"),
    base: "./",
    plugins: [react(), tailwindcss(), skipGlobalDirMigration()],
    resolve: {
      alias: [
        { find: "@gui", replacement: path.join(gui, "src") },
        // Only the harness itself needs these: gui/src resolves them from
        // gui/node_modules on its own.
        { find: /^react$/, replacement: dep("react") },
        { find: /^react\/jsx-runtime$/, replacement: dep("react/jsx-runtime") },
        { find: /^react-dom\/client$/, replacement: dep("react-dom/client") },
        { find: /^react-redux$/, replacement: dep("react-redux") },
        { find: /^styled-components$/, replacement: dep("styled-components") },
        // `core` and the workspace packages, from source
        { find: /^core$/, replacement: path.join(repo, "core", "index.d.ts") },
        { find: /^core\//, replacement: path.join(repo, "core") + "/" },
        // every @continuedev/<name> workspace package, from its src/index.ts
        ...workspacePackages(),
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    server: { fs: { strict: false } },
    build: {
      sourcemap: false,
      minify: false,
      chunkSizeWarningLimit: 100000,
      rollupOptions: {
        // source re-exports of TYPES (export { MCPServer }) have no runtime value
        shimMissingExports: true,
        output: {
          entryFileNames: "assets/[name].js",
          chunkFileNames: "assets/[name].js",
          assetFileNames: "assets/[name].[ext]",
        },
      },
    },
  });
}
