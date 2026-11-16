#!/usr/bin/env node
/**
 * Combines the staged release notes: `.github/release-notes/UNRELEASED.md`
 * plus every fragment in `.github/release-notes/unreleased/*.md` (README.md
 * excepted), grouped by `## ` section, fragments in file-name order.
 *
 *   node scripts/release-notes-fragments.mjs          print the combined sections
 *   node scripts/release-notes-fragments.mjs --clean  delete the fragments
 *
 * Node built-ins only.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const notesDir = join(root, ".github", "release-notes");
const fragmentsDir = join(notesDir, "unreleased");
const SECTION_ORDER = ["New", "Behaviour changes", "Removed", "Fixes"];

function fragmentFiles() {
  if (!existsSync(fragmentsDir)) return [];
  return readdirSync(fragmentsDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => join(fragmentsDir, name));
}

/** Returns [section, lines[]] pairs; text before the first `## ` is ignored. */
function parseSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function combine(files) {
  const bySection = new Map();
  for (const file of files) {
    for (const { name, lines } of parseSections(readFileSync(file, "utf8"))) {
      const body = trimBlankEdges(lines);
      if (body.length === 0) continue;
      if (!bySection.has(name)) bySection.set(name, []);
      bySection.get(name).push(body.join("\n"));
    }
  }
  const names = [
    ...SECTION_ORDER.filter((name) => bySection.has(name)),
    ...[...bySection.keys()].filter((name) => !SECTION_ORDER.includes(name)),
  ];
  return names
    .map((name) => `## ${name}\n\n${bySection.get(name).join("\n")}\n`)
    .join("\n");
}

const fragments = fragmentFiles();

if (process.argv.includes("--clean")) {
  for (const file of fragments) {
    rmSync(file);
    console.log(`deleted ${file}`);
  }
} else {
  const unreleased = join(notesDir, "UNRELEASED.md");
  const files = existsSync(unreleased) ? [unreleased, ...fragments] : fragments;
  process.stdout.write(combine(files));
}
