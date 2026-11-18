#!/usr/bin/env node
// Validates core/util/surfaceFacts.generated.json, offline. Rules (Track PL, PL1):
//  - every fact has a value, a level (declared, measured, derived), a source and a readOn date;
//  - a measured fact has integer k and n (0 <= k <= n, n >= 1) and a runId;
//  - k and n belong to measured facts only; an unknown level or fact name is refused;
//  - quantization is declared only;
//  - rows carry facts, never actions: nothing here can enable tools or recovery.
// Usage: node scripts/ci/check-surface-facts.mjs [path]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FACT_NAMES = [
  "toolsHonoured",
  "toolChoice",
  "parallelCalls",
  "streamingToolArgs",
  "reasoningField",
  "serverParses",
  "quantization",
  "toolForce",
  "toolForceThinking",
  "toolStrictArgs",
  "schemaOutput",
  "grammar",
  "samplingParams",
];
const ENUMS = {
  schemaOutput: ["json-schema", "json-object", "per-model", "none"],
  grammar: ["gbnf", "grammar", "none"],
  samplingParams: ["accepted", "refused"],
};
const LEVELS = ["declared", "measured", "derived"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = ["auto", "required", "named", "none"];

export function validateSurfaceFacts(data) {
  const errors = [];
  if (!data || typeof data !== "object" || data.schemaVersion !== 1) {
    return ["schemaVersion must be 1"];
  }
  if (!Array.isArray(data.rows)) return ["rows must be an array"];
  const ids = new Set();
  data.rows.forEach((row, i) => {
    const where = `rows[${i}] ${row?.id ?? "?"}`;
    if (!row || typeof row.id !== "string" || !row.id) {
      errors.push(`${where}: id missing`);
      return;
    }
    if (ids.has(row.id)) errors.push(`${where}: duplicate id`);
    ids.add(row.id);
    for (const key of ["provider", "engine", "api"]) {
      if (typeof row[key] !== "string" || !row[key]) {
        errors.push(`${where}: ${key} missing (use "*" for any)`);
      }
    }
    if (!row.facts || typeof row.facts !== "object") {
      errors.push(`${where}: facts missing`);
      return;
    }
    if (Object.keys(row.facts).length === 0) errors.push(`${where}: no facts`);
    for (const [name, f] of Object.entries(row.facts)) {
      checkFact(`${where}.${name}`, name, f, errors);
    }
  });
  return errors;
}

function checkFact(where, name, f, errors) {
  if (!FACT_NAMES.includes(name)) errors.push(`${where}: unknown fact name`);
  if (!f || typeof f !== "object") {
    errors.push(`${where}: not an object`);
    return;
  }
  if (f.value === undefined || f.value === null) {
    errors.push(`${where}: value missing`);
  }
  if (name === "toolChoice" && f.value && typeof f.value === "object") {
    for (const [m, v] of Object.entries(f.value)) {
      if (!MODES.includes(m) || typeof v !== "boolean") {
        errors.push(
          `${where}: toolChoice.${m} must be a known mode set to a boolean`,
        );
      }
    }
  }
  if (ENUMS[name] && !ENUMS[name].includes(f.value)) {
    errors.push(`${where}: ${name} must be one of ${ENUMS[name].join(", ")}`);
  }
  if (!LEVELS.includes(f.level)) {
    errors.push(`${where}: level must be one of ${LEVELS.join(", ")}`);
  }
  if (typeof f.source !== "string" || !f.source.trim()) {
    errors.push(`${where}: source missing`);
  }
  if (typeof f.readOn !== "string" || !DATE.test(f.readOn)) {
    errors.push(`${where}: readOn must be YYYY-MM-DD`);
  }
  if (f.expires !== undefined && !DATE.test(String(f.expires))) {
    errors.push(`${where}: expires must be YYYY-MM-DD`);
  }
  if (f.level === "measured") {
    if (
      !Number.isInteger(f.k) ||
      !Number.isInteger(f.n) ||
      f.n < 1 ||
      f.k < 0 ||
      f.k > f.n
    ) {
      errors.push(
        `${where}: measured needs integer k and n with 0 <= k <= n, n >= 1`,
      );
    }
    if (typeof f.runId !== "string" || !f.runId.trim()) {
      errors.push(`${where}: measured needs a runId`);
    }
  } else if (f.k !== undefined || f.n !== undefined) {
    errors.push(`${where}: k and n belong to measured facts only`);
  }
  if (name === "quantization" && f.level !== "declared") {
    errors.push(`${where}: quantization is declared only`);
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const file =
    process.argv[2] ??
    fileURLToPath(
      new URL("../../core/util/surfaceFacts.generated.json", import.meta.url),
    );
  const errors = validateSurfaceFacts(JSON.parse(readFileSync(file, "utf8")));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("surface facts ok");
}
