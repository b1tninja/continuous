#!/usr/bin/env node
// What a bundle is made of, by package.
//
//   node bench/perf/bundle-report.mjs --meta extensions/cli/dist/meta.json [--top 30]
//   node bench/perf/bundle-report.mjs --map gui/dist/assets/index.js [--top 30]
//
// --meta reads an esbuild metafile (the CLI and the VS Code extension write one).
// --map reads a minified chunk and the `.map` next to it (the gui's vite build).
// Prints to stdout; writes nothing.
import { readFileSync } from "node:fs";

import {
  addTo,
  bucketOfPath,
  bucketsOfMetafileOutput,
  charsPerSource,
  topEntries,
} from "./src/buckets.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const top = Number(flag("--top") ?? 30);

function print(name, bytes, totals) {
  console.log(
    `\n${name}: ${(bytes / 1e6).toFixed(2)} MB, ${Object.keys(totals).length} buckets`,
  );
  for (const [key, value] of topEntries(totals, top)) {
    const share = ((100 * value) / bytes).toFixed(1).padStart(5);
    console.log(`${(value / 1e3).toFixed(0).padStart(8)} kB ${share}% ${key}`);
  }
}

const meta = flag("--meta");
const chunk = flag("--map");
if (meta) {
  const metafile = JSON.parse(readFileSync(meta, "utf8"));
  for (const [name, output] of Object.entries(metafile.outputs)) {
    if (name.endsWith(".map")) continue;
    print(name, output.bytes, bucketsOfMetafileOutput(output));
  }
} else if (chunk) {
  const code = readFileSync(chunk, "utf8");
  const map = JSON.parse(readFileSync(`${chunk}.map`, "utf8"));
  const perSource = charsPerSource(
    map.mappings,
    code.split("\n").map((l) => l.length),
  );
  const totals = {};
  for (const [index, chars] of perSource) {
    addTo(totals, bucketOfPath(map.sources[index] ?? "?"), chars);
  }
  print(chunk, code.length, totals);
} else {
  console.error(
    "Usage: bundle-report.mjs --meta <esbuild meta.json> | --map <chunk.js> [--top N]",
  );
  process.exit(2);
}
