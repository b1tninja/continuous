import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Test-only: a new temporary folder, under the name the operating system
 * itself reports for it.
 *
 * `os.tmpdir()` can be another spelling of the folder: an 8.3 short name on
 * Windows (`C:\Users\RUNNER~1\...` on a hosted runner) or a link on macOS
 * (`/var` to `/private/var`). The product resolves paths with
 * `fs.realpathSync.native` and asks about any path that holds a short name,
 * so a test that keeps the unresolved spelling compares two names of one
 * folder and fails on those machines only. Plain `fs.realpathSync` does not
 * expand a short name; the native call does.
 */
export function testTempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Removes a folder made by `testTempDir`. A process cannot remove its own
 * current directory on Windows, so one that is still inside leaves first.
 */
export function removeTestTempDir(dir: string): void {
  const inside = path.relative(dir, process.cwd());
  if (!inside.startsWith("..") && !path.isAbsolute(inside)) {
    process.chdir(path.dirname(dir));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
