#!/usr/bin/env node
// npm pin (docs/supply-chain.md). Plain Node, no install.
// The root package.json names one npm version in `packageManager`. This fails when
//   - the field is missing or is not an exact npm version,
//   - the npm on the path has another major than the pin, or
//   - a committed lockfile has another `lockfileVersion` than the pinned major writes.
// A lockfile does not record the npm that wrote it, only `lockfileVersion`, and npm 9, 10 and 11
// all write 3. So a lockfile written by npm 11 is not caught here; `npm ci` under the pinned npm
// in the build jobs is what catches that. This check catches npm 8 and older, and a CI image
// whose npm moved to another major than the pin.
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PIN = /^npm@(\d+)\.\d+\.\d+(?:\+[0-9A-Za-z.=/+-]+)?$/;
const LOCK_NAMES = ["package-lock.json", "npm-shrinkwrap.json"];

/** The major of an "npm@10.9.9" pin, or undefined when the field is not one. */
export function pinnedMajor(packageManager) {
  const m = PIN.exec(packageManager ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The lockfileVersion an npm major writes by default. */
export function lockfileVersionFor(major) {
  if (major >= 9) return 3;
  if (major >= 7) return 2;
  return 1;
}

/** The npm majors that write this lockfileVersion, for the message. */
export function writersOf(lockfileVersion) {
  const known = { 1: "npm 5 or 6", 2: "npm 7 or 8", 3: "npm 9 or newer" };
  return known[lockfileVersion] ?? "an unknown npm";
}

/**
 * Problems for one repository state.
 *  packageManager: the root field; npmVersion: `npm --version` of the npm on the path;
 *  lockfiles: [{file, lockfileVersion}].
 */
export function check({ packageManager, npmVersion, lockfiles }) {
  const major = pinnedMajor(packageManager);
  if (major === undefined)
    return [
      `package.json: packageManager is ${JSON.stringify(packageManager)}, expected an exact npm version such as "npm@10.9.9"`,
    ];
  const pin = packageManager.split("+")[0];
  const problems = [];
  if (Number.parseInt(npmVersion, 10) !== major)
    problems.push(
      `the npm on the path is ${npmVersion}, package.json pins ${pin}: use npm ${major}, or move the pin and regenerate the lockfiles together`,
    );
  const want = lockfileVersionFor(major);
  for (const { file, lockfileVersion } of lockfiles)
    if (lockfileVersion !== want)
      problems.push(
        `${file}: lockfileVersion ${lockfileVersion} is written by ${writersOf(lockfileVersion)}, ${pin} writes ${want}`,
      );
  return problems;
}

/** Committed npm lockfiles under root, as repository paths. */
export function trackedLockfiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return out.split("\0").filter((f) => LOCK_NAMES.includes(f.split("/").pop()));
}

export function run(root = process.cwd(), npmVersion) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lockfiles = trackedLockfiles(root).map((file) => ({
    file,
    lockfileVersion: JSON.parse(readFileSync(join(root, file), "utf8"))
      .lockfileVersion,
  }));
  return {
    lockfiles,
    problems: check({
      packageManager: pkg.packageManager,
      // execSync, not execFile: npm is npm.cmd on Windows
      npmVersion:
        npmVersion ?? execSync("npm --version", { encoding: "utf8" }).trim(),
      lockfiles,
    }),
  };
}

if (process.argv[1]?.endsWith("check-npm-pin.mjs")) {
  const { lockfiles, problems } = run();
  if (problems.length) {
    console.error(`check-npm-pin: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`check-npm-pin: ok (${lockfiles.length} lockfiles)`);
}
