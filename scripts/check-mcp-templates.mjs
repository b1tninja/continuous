#!/usr/bin/env node
/*
  Dev only: compare the pinned versions in
  core/config/mcpWizard/templates.json with the newest release on each
  package's registry (npm, PyPI, GitHub Container Registry). Nothing in the
  product runs this, and the product never contacts a registry for a
  template; this script is the only place that does, when a maintainer runs
  it by hand.

    node scripts/check-mcp-templates.mjs          report only
    node scripts/check-mcp-templates.mjs --write  also move each pin to the
                                                  newest release and set the
                                                  check dates to today

  Read the release notes of every package it moves before committing: a new
  version is new code that runs on people's machines.
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(
  here,
  "..",
  "core",
  "config",
  "mcpWizard",
  "templates.json",
);
const write = process.argv.includes("--write");

async function json(url, headers = {}) {
  const r = await fetch(url, {
    headers: { accept: "application/json", ...headers },
  });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function latestNpm(name) {
  const j = await json(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
  );
  return j.version;
}

async function latestPypi(name) {
  const j = await json(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
  );
  return j.info.version;
}

/** The highest vX.Y.Z tag of a ghcr.io image (anonymous pull token). */
async function latestGhcr(identifier) {
  const repo = identifier.replace(/^ghcr\.io\//, "").replace(/[:@].*$/, "");
  const { token } = await json(
    `https://ghcr.io/token?scope=repository:${repo}:pull`,
  );
  const auth = { authorization: `Bearer ${token}` };
  let tags = [];
  let url = `https://ghcr.io/v2/${repo}/tags/list?n=1000`;
  while (url) {
    const r = await fetch(url, { headers: auth });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    tags = tags.concat((await r.json()).tags ?? []);
    const next = /<([^>]+)>;\s*rel="next"/.exec(
      r.headers.get("link") ?? "",
    )?.[1];
    url = next ? new URL(next, "https://ghcr.io").toString() : undefined;
  }
  const versions = tags
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const pa = a.slice(1).split(".").map(Number);
      const pb = b.slice(1).split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  return versions.at(-1);
}

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const today = new Date().toISOString().slice(0, 10);
let behind = 0;
for (const t of data.templates) {
  const p = t.package;
  try {
    if (p.registryType === "oci") {
      const current = p.identifier.replace(/^.*:/, "");
      const latest = await latestGhcr(p.identifier);
      const moved = latest && latest !== current;
      console.log(
        `${t.id}: ${current}${moved ? ` -> ${latest}` : " (newest)"}`,
      );
      if (moved) behind++;
      if (moved && write)
        p.identifier = p.identifier.replace(/:[^:]+$/, `:${latest}`);
    } else {
      const latest =
        p.registryType === "npm"
          ? await latestNpm(p.identifier)
          : await latestPypi(p.identifier);
      const moved = latest !== p.version;
      console.log(
        `${t.id}: ${p.version}${moved ? ` -> ${latest}` : " (newest)"}`,
      );
      if (moved) behind++;
      if (moved && write) p.version = latest;
    }
    if (write) p.versionChecked = today;
  } catch (e) {
    console.error(`${t.id}: could not check (${e.message})`);
    process.exitCode = 1;
  }
}
if (write && !process.exitCode) {
  data.checked = today;
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Wrote ${path.relative(process.cwd(), FILE)}. Run prettier and the templates test.`,
  );
} else if (behind) {
  console.log(`${behind} template(s) behind. Run with --write to move them.`);
}
