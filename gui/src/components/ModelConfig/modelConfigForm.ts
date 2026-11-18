import type { ModelBlockInfo } from "core/config/modelEdit/modelBlockEdit";
import {
  capabilitiesFor,
  capabilityState,
  getPath,
  MODEL_EDIT_FIELDS,
  pathKey,
  secretRef,
  SENSITIVE_HEADER,
  validateFieldValue,
  type CredentialState,
  type ModelEditField,
  type ModelPatchOp,
  type TriState,
} from "core/config/modelEdit/modelEditFields";
import { isValidSecretName } from "core/util/unresolvedSecrets";

/**
 * The dialog's state as the inputs hold it: text for text, number and list
 * fields ("" means the key is absent and the default applies), a tri-state
 * for booleans, a set for roles (null: absent, the default roles apply).
 */
export type BoolChoice = "default" | "on" | "off";

export interface HeaderRow {
  /** Stable key for React. */
  id: string;
  name: string;
  /** For a credential header this is "" until a new reference is typed. */
  value: string;
  /** The header existed and its value is a credential, so it was withheld. */
  withheld?: CredentialState;
}

export type KeyChoice =
  /** Leave apiKey as written. */
  | { mode: "keep" }
  /** Refer to a secret; `value` (optional) is stored under that name before saving. */
  | {
      mode: "secret";
      secretName: string;
      value: string;
      storage: "secure" | "env";
    }
  /** Remove apiKey from the entry. */
  | { mode: "remove" };

/** One tool's override in the Templates tab. */
export interface ToolOverrideRow {
  /** Stable key for React. */
  id: string;
  /** The tool's name, such as read_file. */
  tool: string;
  /** "" keeps the tool's own description. */
  description: string;
  disabled: boolean;
  /** The override as written, so keys this editor does not show are kept. */
  raw?: Record<string, unknown>;
}

export interface ModelForm {
  fields: Record<string, string | string[] | null>;
  tools: TriState;
  images: TriState;
  headers: HeaderRow[];
  key: KeyChoice;
  /** The other credential fields (env.accessKeyId, ...), by path key. */
  secrets: Record<string, KeyChoice>;
  toolOverrides: ToolOverrideRow[];
  /** `capabilities` as written, so names the dialog does not manage are kept. */
  rawCapabilities?: unknown;
}

/** Credential fields other than apiKey: written only as secret references. */
export const SECRET_FIELDS = MODEL_EDIT_FIELDS.filter(
  (f) => f.kind === "secretRef" && pathKey(f.path) !== "apiKey",
);

export function isBooleanField(f: ModelEditField) {
  return f.kind === "boolean";
}

/** The fields of a section that apply to this provider (or are already written). */
export function visibleFields(
  section: ModelEditField["section"],
  provider: string,
  entry: Record<string, unknown> | undefined,
): ModelEditField[] {
  return MODEL_EDIT_FIELDS.filter(
    (f) =>
      f.section === section &&
      f.kind !== "secretRef" &&
      (!f.providers ||
        f.providers.includes(provider) ||
        getPath(entry, f.path) !== undefined),
  );
}

function toInput(f: ModelEditField, raw: unknown): string | string[] | null {
  if (pathKey(f.path) === "roles") {
    return Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : null;
  }
  if (raw === undefined || raw === null) {
    return f.kind === "boolean" ? "default" : "";
  }
  switch (f.kind) {
    case "boolean":
      return raw === true ? "on" : raw === false ? "off" : "default";
    case "list":
      return Array.isArray(raw) ? raw.map(String).join("\n") : String(raw);
    default:
      return String(raw);
  }
}

/** The form for an entry: every field prefilled from what is written. */
export function formFromBlock(info: ModelBlockInfo): ModelForm {
  const entry = info.entry ?? {};
  const fields: ModelForm["fields"] = {};
  for (const f of MODEL_EDIT_FIELDS) {
    if (f.kind === "secretRef") continue;
    fields[pathKey(f.path)] = toInput(f, getPath(entry, f.path));
  }
  const rawHeaders = getPath(entry, ["requestOptions", "headers"]);
  const headers: HeaderRow[] =
    rawHeaders && typeof rawHeaders === "object"
      ? Object.entries(rawHeaders as Record<string, unknown>).map(
          ([name, value], i) => {
            const withheld = info.credentials?.headers[name];
            return withheld
              ? { id: `h${i}`, name, value: "", withheld }
              : { id: `h${i}`, name, value: String(value) };
          },
        )
      : [];
  const rawOverrides = getPath(entry, ["chatOptions", "toolOverrides"]);
  const toolOverrides: ToolOverrideRow[] = isRecord(rawOverrides)
    ? Object.entries(rawOverrides).map(([tool, raw], i) => {
        const o = isRecord(raw) ? raw : {};
        return {
          id: `t${i}`,
          tool,
          description: typeof o.description === "string" ? o.description : "",
          disabled: o.disabled === true,
          raw: o,
        };
      })
    : [];
  return {
    fields,
    tools: capabilityState(entry.capabilities, "tool_use"),
    images: capabilityState(entry.capabilities, "image_input"),
    headers,
    key: { mode: "keep" },
    secrets: Object.fromEntries(
      SECRET_FIELDS.map((f) => [pathKey(f.path), { mode: "keep" } as const]),
    ),
    toolOverrides,
    rawCapabilities: entry.capabilities,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The value to write for a field's input, or undefined to remove the key. */
export function fromInput(
  f: ModelEditField,
  input: string | string[] | null,
): unknown {
  if (pathKey(f.path) === "roles") return input === null ? undefined : input;
  if (typeof input !== "string") return undefined;
  switch (f.kind) {
    case "multiline":
      // Written as typed: leading spaces and inner blank lines can matter in a prompt
      return input.trim() === "" ? undefined : input.replace(/\s+$/, "");
    case "boolean":
      return input === "on" ? true : input === "off" ? false : undefined;
    case "number":
      return input.trim() === "" ? undefined : Number(input.trim());
    case "list": {
      const items = input
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length === 0) return undefined;
      // A single CA bundle is written as a path, as the docs show it
      if (
        pathKey(f.path) === "requestOptions.caBundlePath" &&
        items.length === 1
      ) {
        return items[0];
      }
      return items;
    }
    default:
      return input.trim() === "" ? undefined : input.trim();
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export interface FormResult {
  ops: ModelPatchOp[];
  /** Field-level messages, keyed by path ("apiKey", "requestOptions.headers.X"). */
  errors: Record<string, string>;
}

/**
 * The changes to write: only fields whose input differs from the prefilled
 * one, so a default shown as a placeholder is never written.
 */
export function formToOps(initial: ModelForm, current: ModelForm): FormResult {
  const ops: ModelPatchOp[] = [];
  const errors: Record<string, string> = {};
  const push = (path: string[], value: unknown) => {
    const message = validateFieldValue(path, value);
    if (message) errors[pathKey(path)] = message;
    else ops.push(value === undefined ? { path } : { path, value });
  };

  for (const f of MODEL_EDIT_FIELDS) {
    if (f.kind === "secretRef") continue;
    const k = pathKey(f.path);
    if (same(initial.fields[k], current.fields[k])) continue;
    push(f.path, fromInput(f, current.fields[k]));
  }

  if (current.tools !== initial.tools || current.images !== initial.images) {
    const caps = capabilitiesFor(
      initial.rawCapabilities,
      current.tools,
      current.images,
    );
    if (caps.error) errors.capabilities = caps.error;
    else push(["capabilities"], caps.value);
  }

  headerOps(initial.headers, current.headers, push, errors);

  const secretOps = (path: string[], choice: KeyChoice | undefined) => {
    if (!choice || choice.mode === "keep") return;
    if (choice.mode === "remove") return push(path, undefined);
    if (!isValidSecretName(choice.secretName)) {
      errors[pathKey(path)] =
        "A secret name is letters, digits and _, not starting with a digit.";
    } else {
      push(path, secretRef(choice.secretName));
    }
  };
  secretOps(["apiKey"], current.key);
  for (const f of SECRET_FIELDS) {
    secretOps(f.path, current.secrets?.[pathKey(f.path)]);
  }

  toolOverrideOps(
    initial.toolOverrides ?? [],
    current.toolOverrides ?? [],
    push,
    errors,
  );
  return { ops, errors };
}

/** The override a row stands for, or undefined when it overrides nothing. */
export function overrideValue(
  row: ToolOverrideRow,
): Record<string, unknown> | undefined {
  const { description: _d, disabled: _x, ...rest } = row.raw ?? {};
  const value: Record<string, unknown> = { ...rest };
  if (row.description.trim()) value.description = row.description.trim();
  if (row.disabled) value.disabled = true;
  return Object.keys(value).length > 0 ? value : undefined;
}

function toolOverrideOps(
  before: ToolOverrideRow[],
  after: ToolOverrideRow[],
  push: (path: string[], value: unknown) => void,
  errors: Record<string, string>,
) {
  const seen = new Set<string>();
  for (const row of after) {
    const tool = row.tool.trim();
    if (!tool) {
      if (row.description.trim() || row.disabled) {
        errors[`chatOptions.toolOverrides.${row.id}`] = "Choose the tool.";
      }
      continue;
    }
    const path = ["chatOptions", "toolOverrides", tool];
    if (seen.has(tool)) {
      errors[pathKey(path)] = "This tool is listed twice.";
      continue;
    }
    seen.add(tool);
    const old = before.find((b) => b.tool === tool);
    const value = overrideValue(row);
    if (old && same(overrideValue(old), value)) continue;
    if (!old && value === undefined) continue;
    push(path, value);
  }
  for (const old of before) {
    if (!after.some((a) => a.tool.trim() === old.tool)) {
      push(["chatOptions", "toolOverrides", old.tool], undefined);
    }
  }
}

/** A secret the dialog stores (config/setSecret) before it saves the reference. */
export interface SecretToStore {
  /** What it is, for the review: "API key", "AWS secret access key". */
  label: string;
  secretName: string;
  value: string;
  storage: "secure" | "env";
}

/** Every typed credential to store before the save, apiKey first. */
export function secretsToStore(form: ModelForm): SecretToStore[] {
  const out: SecretToStore[] = [];
  const add = (label: string, c: KeyChoice | undefined) => {
    if (c?.mode === "secret" && c.value !== "") {
      out.push({
        label,
        secretName: c.secretName,
        value: c.value,
        storage: c.storage,
      });
    }
  };
  add("API key", form.key);
  for (const f of SECRET_FIELDS) add(f.label, form.secrets?.[pathKey(f.path)]);
  return out;
}

const isPrefix = (a: readonly string[], b: readonly string[]) =>
  a.length <= b.length && a.every((x, i) => b[i] === x);

/**
 * The form's changes and the Advanced tab's together. The same change made in
 * both is kept once; different changes to one setting (or to a setting and a
 * map that holds it) are a conflict, so neither silently wins.
 */
export function mergeOps(
  formOps: readonly ModelPatchOp[],
  yamlOps: readonly ModelPatchOp[],
): { ops: ModelPatchOp[]; conflicts: string[] } {
  const ops: ModelPatchOp[] = [...formOps];
  const conflicts: string[] = [];
  for (const y of yamlOps) {
    const overlapping = formOps.filter(
      (f) => isPrefix(f.path, y.path) || isPrefix(y.path, f.path),
    );
    if (overlapping.length === 0) {
      ops.push(y);
      continue;
    }
    const identical = overlapping.every(
      (f) => pathKey(f.path) === pathKey(y.path) && same(f.value, y.value),
    );
    if (!identical) conflicts.push(pathKey(y.path));
  }
  return { ops, conflicts };
}

function headerOps(
  before: HeaderRow[],
  after: HeaderRow[],
  push: (path: string[], value: unknown) => void,
  errors: Record<string, string>,
) {
  const seen = new Set<string>();
  for (const row of after) {
    const name = row.name.trim();
    if (!name) {
      if (row.value.trim())
        errors[`requestOptions.headers.${row.id}`] = "Enter the header name.";
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors[`requestOptions.headers.${name}`] = "This header is listed twice.";
      continue;
    }
    seen.add(name.toLowerCase());
    const old = before.find((b) => b.name === name);
    const path = ["requestOptions", "headers", name];
    if (old?.withheld && row.value === "") continue; // kept as written
    if (old && !old.withheld && old.value === row.value) continue;
    if (!row.value.trim() && !old) {
      errors[pathKey(path)] = "Enter a value.";
      continue;
    }
    push(path, row.value.trim());
  }
  for (const old of before) {
    if (!after.some((a) => a.name.trim() === old.name)) {
      push(["requestOptions", "headers", old.name], undefined);
    }
  }
}

/** The message for one field as typed, for showing while editing. */
export function fieldError(
  f: ModelEditField,
  input: string | string[] | null,
): string | undefined {
  if (
    pathKey(f.path) === "roles" &&
    Array.isArray(input) &&
    input.length === 0
  ) {
    return "Pick at least one role, or go back to the default roles.";
  }
  return validateFieldValue(f.path, fromInput(f, input));
}

/** Header values that are credentials must be references. */
export function headerIsSensitive(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}
