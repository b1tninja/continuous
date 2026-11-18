#!/usr/bin/env node

// The `cn` / `continuous` executable (dist/cn.js). Kept tiny on purpose: the
// CLI itself is the 18 MB bundle beside it, loaded below only when needed.
import { answerVersionFast, enableCliCompileCache } from "./fastStart.js";

if (!answerVersionFast(process.argv.slice(2), import.meta.url)) {
  enableCliCompileCache();
  // A dynamic import, so the cache is on before the bundle is compiled.
  // build.mjs keeps "./index.js" external: this resolves to dist/index.js.
  const { runCli } = await import("./index.js");
  await runCli();
}
