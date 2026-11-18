#!/usr/bin/env node
// Generate THIRD_PARTY_NOTICES.txt for a shipped artefact, and refuse copyleft or unknown licences.
//
//   node scripts/licenses/third-party-notices.mjs <outFile> <projectDir>... [--exceptions file] [--check-only]
//
// Each <projectDir> holds a package-lock.json and an installed node_modules. Every non-dev
// package in the lockfile is listed once (name@version) with its licence id (the lockfile's
// `license` field, else the installed package.json's) and the text of its own LICENSE file.
// Packages that share identical text are grouped, which keeps the file small.
//
// Policy: an SPDX expression passes when one OR-alternative has every AND-term on the allowlist
// below. Anything else (GPL, AGPL, LGPL, SSPL, BUSL, non-commercial, "UNLICENSED", missing)
// fails the run unless the package is listed, with a reason, in the exceptions file
// (scripts/licenses/exceptions.json: {"name": "reason"}, {"name@version": "reason"} or {"@scope/*": "reason"}).
// Plain Node, no install.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set(
  [
    "MIT",
    "MIT-0",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD-3-Clause-Clear",
    "0BSD",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BlueOak-1.0.0",
    "CC0-1.0",
    "CC-BY-3.0",
    "CC-BY-4.0",
    "Unlicense",
    "Zlib",
    "Python-2.0",
    "PSF-2.0",
    "WTFPL",
    "MPL-2.0", // file-level copyleft; unmodified use is a notice-only obligation
    "OFL-1.1",
    "Unicode-3.0",
    "Unicode-DFS-2016",
  ].map((s) => s.toLowerCase()),
);

/** SPDX expression -> true when the policy allows it. */
export function isAllowed(expr) {
  if (!expr || typeof expr !== "string") return false;
  const clean = expr.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return clean.split(/ OR /i).some((alt) =>
    alt
      .split(/ AND /i)
      .map((t) => t.trim())
      .every((t) => ALLOWED.has(t.toLowerCase())),
  );
}

/** package.json license fields of any vintage -> one string, or null. */
export function licenseOf(meta) {
  if (!meta) return null;
  if (typeof meta.license === "string") return meta.license;
  if (meta.license && typeof meta.license.type === "string")
    return meta.license.type;
  if (Array.isArray(meta.licenses) && meta.licenses.length)
    return meta.licenses
      .map((l) => (typeof l === "string" ? l : l?.type))
      .filter(Boolean)
      .join(" OR ");
  return null;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function readText(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => LICENSE_FILE.test(n));
  // LICENSE first, NOTICE after: both are part of what must travel
  names.sort((a, b) => a.localeCompare(b));
  const parts = names
    .map((n) => {
      try {
        return readFileSync(join(dir, n), "utf8").replace(/\r\n/g, "\n").trim();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/** Non-dev packages of one project's lockfile, with licence ids and texts. */
export function collect(projectDir) {
  const lockFile = join(projectDir, "package-lock.json");
  if (!existsSync(lockFile))
    throw new Error(`no package-lock.json in ${projectDir}`);
  if (!existsSync(join(projectDir, "node_modules")))
    throw new Error(
      `${projectDir} has a lockfile but no node_modules: install it before generating notices`,
    );
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf("node_modules/");
    if (at < 0 || entry.link || entry.dev) continue;
    const name = key.slice(at + "node_modules/".length);
    const dir = join(projectDir, key);
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      /* not installed (platform-specific optional package) */
    }
    out.push({
      name,
      version: entry.version ?? meta?.version ?? "?",
      license: entry.license ?? licenseOf(meta),
      installed: meta !== null,
      text: readText(dir),
      optional: Boolean(entry.optional),
    });
  }
  return out;
}

export function loadExceptions(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** An exception matches name@version, name, or a scope wildcard such as "@img/*". */
function exceptionKey(p, exceptions) {
  if (p.id in exceptions) return p.id;
  if (p.name in exceptions) return p.name;
  return (
    Object.keys(exceptions).find(
      (k) => k.endsWith("/*") && p.name.startsWith(k.slice(0, -1)),
    ) ?? null
  );
}

/** Merge projects, dedupe by name@version, split into accepted and violations. */
export function analyse(packages, exceptions = {}) {
  const byId = new Map();
  for (const p of packages) {
    const id = `${p.name}@${p.version}`;
    const prior = byId.get(id);
    if (!prior || (!prior.text && p.text) || (!prior.license && p.license))
      byId.set(id, { ...p, id });
  }
  const accepted = [];
  const violations = [];
  const usedExceptions = new Set();
  for (const p of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = exceptionKey(p, exceptions);
    if (isAllowed(p.license)) accepted.push(p);
    else if (key) {
      usedExceptions.add(key);
      accepted.push({ ...p, reason: exceptions[key] });
    } else violations.push(p);
  }
  return { accepted, violations, usedExceptions };
}

export function render(accepted) {
  const groups = new Map();
  const noText = [];
  for (const p of accepted) {
    if (!p.text) {
      noText.push(p);
      continue;
    }
    const h = createHash("sha256").update(p.text).digest("hex");
    if (!groups.has(h)) groups.set(h, { text: p.text, pkgs: [] });
    groups.get(h).pkgs.push(p);
  }
  const bar = "=".repeat(80);
  const label = (p) => `${p.id} (${p.license ?? "licence not declared"})`;
  const lines = [
    "Third-party notices",
    "",
    "Continuous includes the open-source packages listed below. Each is distributed",
    "under its own licence; the licence text follows the list of packages it covers.",
    "Generated at build time from package-lock.json and node_modules; do not edit.",
    "",
  ];
  const sorted = [...groups.values()].sort((a, b) =>
    a.pkgs[0].id.localeCompare(b.pkgs[0].id),
  );
  for (const g of sorted) {
    lines.push(bar);
    for (const p of g.pkgs) lines.push(label(p));
    lines.push(bar, "", g.text, "");
  }
  if (noText.length) {
    lines.push(
      bar,
      "Packages that ship no licence file; licence as declared",
      bar,
      "",
    );
    for (const p of noText) lines.push(label(p));
    lines.push("");
  }
  const reviewed = accepted.filter((p) => p.reason);
  if (reviewed.length) {
    lines.push(bar, "Packages under reviewed exceptions", bar, "");
    for (const p of reviewed) lines.push(`${label(p)}: ${p.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function run(projectDirs, { exceptionsFile, outFile } = {}) {
  const exceptions = loadExceptions(exceptionsFile);
  const all = projectDirs.flatMap((d) => collect(resolve(d)));
  const result = analyse(all, exceptions);
  if (outFile) writeFileSync(outFile, render(result.accepted));
  return {
    ...result,
    exceptions,
    total: result.accepted.length + result.violations.length,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  let exceptionsFile = join(here, "exceptions.json");
  const checkOnly = args.includes("--check-only");
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--exceptions") exceptionsFile = args[++i];
    else if (args[i] !== "--check-only") rest.push(args[i]);
  }
  const outFile = checkOnly ? undefined : rest.shift();
  if (rest.length === 0) {
    console.error(
      "usage: third-party-notices.mjs <outFile> <projectDir>... [--exceptions file] [--check-only]",
    );
    process.exit(2);
  }
  const r = run(rest, { exceptionsFile, outFile });
  const noText = r.accepted.filter((p) => !p.text).length;
  console.log(
    `${r.total} packages; ${r.violations.length} not allowed; ${noText} without a licence file${outFile ? `; wrote ${outFile}` : ""}`,
  );
  const unused = Object.keys(r.exceptions).filter(
    (k) => !r.usedExceptions.has(k),
  );
  if (unused.length)
    console.log(`unused exceptions (remove them): ${unused.join(", ")}`);
  if (r.violations.length) {
    console.error(
      "licences outside the allowlist (review, then add to exceptions.json with a reason):",
    );
    for (const p of r.violations)
      console.error(`  ${p.id}: ${p.license ?? "NONE"}`);
    process.exit(1);
  }
}
