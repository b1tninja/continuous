import * as fs from "node:fs";

/**
 * Makes a real link for a test, and says why when it cannot, so a test skips
 * with a reason instead of passing without having proved anything.
 *
 * Which runner proves which case (the core tests run on ubuntu-latest in
 * pull requests; no macOS or Windows job runs them, so the other two are
 * proved on a developer machine or the Windows Sandbox recipe):
 *
 * - directory link: a symlink on Linux and macOS, a junction on Windows (no
 *   privilege needed), so it runs on all three
 * - file link: a symlink on Linux and macOS; on Windows it needs Developer
 *   Mode or an elevated session, so it skips there when that is missing
 * - case-insensitive file system: macOS (default APFS) and Windows only
 * - a temp folder that is itself a link (`/var` to `/private/var`): macOS only
 */
export interface LinkResult {
  ok: boolean;
  /** Why the link could not be made; empty when it was. */
  reason: string;
}

export function tryLink(
  target: string,
  linkPath: string,
  kind: "dir" | "file" = "dir",
): LinkResult {
  const type =
    process.platform === "win32"
      ? kind === "dir"
        ? "junction"
        : "file"
      : kind;
  try {
    fs.symlinkSync(target, linkPath, type);
    return { ok: true, reason: "" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    return {
      ok: false,
      reason: `a ${type} link cannot be made on ${process.platform} (${code})`,
    };
  }
}

/** The title of a test that needs a link: says it is skipped, and why. */
export const needsLink = (title: string, link: LinkResult) =>
  link.ok ? title : `${title} (skipped: ${link.reason})`;

/** Is the file system under `dir` case-insensitive? Probed, not assumed from the platform. */
export function isCaseInsensitive(dir: string): boolean {
  const probe = `${dir}/CaseProbe.tmp`;
  try {
    fs.writeFileSync(probe, "x");
    return fs.existsSync(`${dir}/caseprobe.tmp`);
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
