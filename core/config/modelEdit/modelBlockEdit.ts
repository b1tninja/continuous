/**
 * Read, preview and save a change to one model entry of a config.yaml for the
 * model configuration dialog.
 *
 * The text-level functions (`readModelBlock`, `editModelBlockText`) take and
 * return YAML text and do no I/O. The file-level ones work on the config the
 * GUI edits (`getEditableConfigYamlPath`, the same file every other GUI save
 * writes) and refuse to write when the file changed since the preview.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  connectedModelSchema,
  modelSchema,
  type ConfigYaml,
} from "@continuedev/config-yaml";
import { diffLines } from "diff";
import * as YAML from "yaml";

import {
  editConfigYamlFile,
  getContinueGlobalPath,
  getEditableConfigYamlPath,
} from "../../util/paths";
import { editYamlText } from "../../util/yamlEdit";
import { entryYamlText } from "./entryYaml";
import {
  applyModelPatch,
  credentialState,
  maskEntry,
  maskYamlLine,
  SENSITIVE_HEADER,
  validateEntry,
  type CredentialState,
  type FieldError,
  type ModelPatchOp,
} from "./modelEditFields";

export type ConfigScope = "user" | "workspace";

export interface ModelBlockInfo {
  /** False when the dialog may show the model but not save it. */
  editable: boolean;
  /** Why it is not editable, in a sentence. */
  reason?: string;
  /** The file a save writes, when there is one. */
  file?: string;
  scope?: ConfigScope;
  /** The entry as written, with plain credential values masked. */
  entry?: Record<string, unknown>;
  /** The entry's own YAML lines (comments kept), credentials masked: the Advanced tab. */
  entryYaml?: string;
  credentials?: {
    apiKey: CredentialState;
    /** Only for header names that carry credentials. */
    headers: Record<string, CredentialState>;
    env: Record<string, CredentialState>;
  };
}

export interface DiffLine {
  kind: "add" | "del" | "same" | "gap";
  text: string;
}

export interface ModelEditPreview {
  errors: FieldError[];
  /** Whether the patch changes the file at all. */
  changed: boolean;
  /** Changed lines with two lines of context; credentials masked. */
  diff: DiffLine[];
  /** Pass back to save; a save refuses when the file no longer matches it. */
  baseHash?: string;
  /** Set when the file cannot be edited at all. */
  error?: string;
}

export interface ModelEditSaveResult {
  saved: boolean;
  errors: FieldError[];
  error?: string;
  /** The file changed after the preview; preview again. */
  stale?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Located =
  | { ok: true; index: number; entry: Record<string, unknown> }
  | { ok: false; reason: string };

function locate(config: unknown, title: string): Located {
  const models = isPlainObject(config) ? config.models : undefined;
  if (!Array.isArray(models)) {
    return { ok: false, reason: "This config has no models list." };
  }
  const hits = models
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => isPlainObject(m) && m.name === title);
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `No model named "${title}" is written in this config. It may come from a block, a catalog or a hub assistant; open its file to change it.`,
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `${hits.length} models are named "${title}" in this config. Give each a different name first.`,
    };
  }
  const entry = hits[0].m as Record<string, unknown>;
  if (typeof entry.uses === "string" || typeof entry.from === "string") {
    return {
      ok: false,
      reason: `"${title}" is used from ${String(entry.uses ?? entry.from)}; its settings are written there.`,
    };
  }
  return { ok: true, index: hits[0].index, entry };
}

function parseConfig(text: string): { config?: unknown; error?: string } {
  const doc = YAML.parseDocument(text.replace(/^﻿/, ""));
  if (doc.errors.length > 0) return { error: doc.errors[0].message };
  return { config: doc.toJS() };
}

function credentialsOf(entry: Record<string, unknown>) {
  const headers: Record<string, CredentialState> = {};
  const rawHeaders = isPlainObject(entry.requestOptions)
    ? entry.requestOptions.headers
    : undefined;
  if (isPlainObject(rawHeaders)) {
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (SENSITIVE_HEADER.test(name)) headers[name] = credentialState(value);
    }
  }
  const env: Record<string, CredentialState> = {};
  if (isPlainObject(entry.env)) {
    for (const key of ["accessKeyId", "secretAccessKey", "sessionToken"]) {
      if (key in entry.env) env[key] = credentialState(entry.env[key]);
    }
  }
  return { apiKey: credentialState(entry.apiKey), headers, env };
}

/** The model entry named `title`, masked for the webview. */
export function readModelBlock(text: string, title: string): ModelBlockInfo {
  const { config, error } = parseConfig(text);
  if (error) {
    return { editable: false, reason: `The config cannot be read: ${error}` };
  }
  const found = locate(config, title);
  if (!found.ok) return { editable: false, reason: found.reason };
  const entry = maskEntry(found.entry) as Record<string, unknown>;
  return {
    editable: true,
    entry,
    entryYaml: entryYamlText(text, found.index, entry),
    credentials: credentialsOf(found.entry),
  };
}

function schemaErrors(entry: Record<string, unknown>): FieldError[] {
  const schema =
    typeof entry.connection === "string" ? connectedModelSchema : modelSchema;
  const parsed = schema.safeParse(entry);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => ({
    path: i.path.map(String),
    message: i.message,
  }));
}

type Plan =
  | { ok: true; index: number; entry: Record<string, unknown> }
  | { ok: false; errors: FieldError[]; error?: string };

/** The entry after the dialog's changes, checked field by field and against the schema. */
function planEdit(
  text: string,
  title: string,
  ops: readonly ModelPatchOp[],
): Plan {
  const { config, error } = parseConfig(text);
  if (error) {
    return {
      ok: false,
      errors: [],
      error: `The config cannot be read: ${error}`,
    };
  }
  const found = locate(config, title);
  if (!found.ok) return { ok: false, errors: [], error: found.reason };
  const { entry, errors } = applyModelPatch(found.entry, ops);
  if (errors.length > 0) return { ok: false, errors };
  const own = validateEntry(entry);
  const reported = new Set(own.map((e) => e.path.join(".")));
  const entryErrors = [
    ...own,
    ...schemaErrors(entry).filter((e) => !reported.has(e.path.join("."))),
  ];
  if (entryErrors.length > 0) return { ok: false, errors: entryErrors };
  return { ok: true, index: found.index, entry };
}

function withEntry(
  config: ConfigYaml,
  index: number,
  entry: Record<string, unknown>,
): ConfigYaml {
  const models = [...((config as { models?: unknown[] }).models ?? [])];
  models[index] = entry;
  return { ...config, models } as ConfigYaml;
}

/**
 * Apply the dialog's changes to the entry named `title` in `text`. Returns the
 * new text (undefined when nothing changes) or the reasons it was refused.
 */
export function editModelBlockText(
  text: string,
  title: string,
  ops: readonly ModelPatchOp[],
): { text?: string; errors: FieldError[]; error?: string } {
  const plan = planEdit(text, title, ops);
  if (!plan.ok) return { errors: plan.errors, error: plan.error };
  const result = editYamlText<ConfigYaml>(text, (c) =>
    withEntry(c, plan.index, plan.entry),
  );
  if (result.error) return { errors: [], error: result.error };
  return { text: result.text, errors: [] };
}

/** Changed lines with `context` lines around each change, credentials masked. */
export function diffText(
  before: string,
  after: string,
  context = 2,
): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? "add" : part.removed ? "del" : "same";
    const body = part.value.endsWith("\n")
      ? part.value.slice(0, -1)
      : part.value;
    for (const line of body.split(/\r?\n/)) {
      lines.push({ kind, text: maskYamlLine(line) });
    }
  }
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (
      let j = Math.max(0, i - context);
      j <= Math.min(lines.length - 1, i + context);
      j++
    ) {
      keep[j] = true;
    }
  });
  const out: DiffLine[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.length > 0 && out[out.length - 1].kind !== "gap") {
      out.push({ kind: "gap", text: "" });
    }
  });
  while (out.length > 0 && out[out.length - 1].kind === "gap") out.pop();
  return out;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Preview a change on text: the diff and the hash a save must match. */
export function previewModelEditText(
  text: string,
  title: string,
  ops: readonly ModelPatchOp[],
): ModelEditPreview {
  const edit = editModelBlockText(text, title, ops);
  if (edit.error || edit.errors.length > 0) {
    return {
      errors: edit.errors,
      error: edit.error,
      changed: false,
      diff: [],
    };
  }
  return {
    errors: [],
    changed: edit.text !== undefined,
    diff: edit.text === undefined ? [] : diffText(text, edit.text),
    baseHash: hashText(text),
  };
}

function scopeOf(file: string): ConfigScope {
  const rel = path.relative(getContinueGlobalPath(), file);
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? "user" : "workspace";
}

function readEditable(): { file?: string; text?: string; reason?: string } {
  const file = getEditableConfigYamlPath();
  if (!file) {
    return {
      reason:
        "The selected configuration is not a local config.yaml, so it cannot be edited here.",
    };
  }
  try {
    return { file, text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    return {
      file,
      reason: `Could not read ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** The model entry from the config the GUI edits. */
export function getModelBlock(title: string): ModelBlockInfo {
  const { file, text, reason } = readEditable();
  if (text === undefined) return { editable: false, reason, file };
  return { ...readModelBlock(text, title), file, scope: scopeOf(file!) };
}

export function previewModelEdit(
  title: string,
  ops: readonly ModelPatchOp[],
): ModelEditPreview {
  const { text, reason } = readEditable();
  if (text === undefined) {
    return { errors: [], changed: false, diff: [], error: reason };
  }
  return previewModelEditText(text, title, ops);
}

/**
 * Write the change, after checking the file is still the one the preview was
 * made from. Comments, key order and every key the dialog does not manage are
 * kept (editYamlText).
 */
export function saveModelEdit(
  title: string,
  ops: readonly ModelPatchOp[],
  baseHash: string,
): ModelEditSaveResult {
  const { file, text, reason } = readEditable();
  if (text === undefined || !file) {
    return { saved: false, errors: [], error: reason };
  }
  if (hashText(text) !== baseHash) {
    return {
      saved: false,
      errors: [],
      stale: true,
      error: `${path.basename(file)} changed since the preview. Review the changes again.`,
    };
  }
  const plan = planEdit(text, title, ops);
  if (!plan.ok) return { saved: false, errors: plan.errors, error: plan.error };
  const result = editConfigYamlFile(file, (config) =>
    withEntry(config, plan.index, plan.entry),
  );
  if (!result.ok) return { saved: false, errors: [], error: result.error };
  return { saved: result.changed, errors: [] };
}
