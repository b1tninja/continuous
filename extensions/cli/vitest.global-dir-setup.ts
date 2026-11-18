// IMPORTANT: This file must run BEFORE any module that imports
// `core/util/paths.ts`, because that module resolves `CONTINUE_GLOBAL_DIR`
// into a constant at import time. If multiple test files (which run in
// parallel worker processes) all share the same global dir, they race on the
// same `globalContext.json` file on disk, causing flaky failures in the
// model-persistence tests.
//
// To guarantee isolation, give each worker process its own unique global dir.
// This file is intentionally dependency-free (no imports that transitively
// load `paths.ts`) and is listed first in `setupFiles` so the env var is set
// before any other module captures it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-cli-test-"));
process.env.CONTINUE_GLOBAL_DIR = globalDir;

// Give every worker a local config.yaml with one chat model. Tests that call
// initializeServices() need a model to exist; without this they relied on a
// hosted default config (fetched on first run) or on a developer's own
// ANTHROPIC_API_KEY and ~/.continuous/config.yaml. A clean CI machine has
// neither, and a first run with nothing configured loads an empty assistant,
// so ModelService (and every service after it) ends in state "error".
// The key is a placeholder: nothing here makes a network call.
fs.writeFileSync(
  path.join(globalDir, "config.yaml"),
  [
    "name: Test Config",
    "version: 1.0.0",
    "schema: v1",
    "models:",
    "  - name: Test Model",
    "    provider: anthropic",
    "    model: claude-sonnet-4-6",
    "    apiKey: test-key-not-real",
    "    roles:",
    "      - chat",
    "",
  ].join("\n"),
);

// Best-effort cleanup of this worker's temp dir when the process exits.
process.on("exit", () => {
  try {
    fs.rmSync(globalDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on exit.
  }
});
