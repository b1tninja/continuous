import data from "./templates.json";
import type { McpDraftValue, McpServerDraft } from "./types";

/*
  MCPW6: the eight bundled templates (plans/research/mcp-server-wizard.md
  section 12.5, Start step). The data is one file, templates.json, in the
  MCP Registry's server.json field names, so a template and a registry entry
  fill the Simple screen the same way: `isRequired` makes a field,
  `isSecret` makes it a password field stored as a secret, `default`
  pre-fills it, `choices` makes a picker and `value` is fixed (decision W3).

  Every package is pinned to an exact version that was checked on the date
  in the file. Nothing is looked up at run time; a newer version is found
  only by the dev-only script scripts/check-mcp-templates.mjs.
*/

export type McpTemplateCategory =
  "files" | "developer" | "web" | "memory" | "reasoning" | "data";

export type McpInputFormat = "string" | "number" | "boolean" | "filepath";

/** The registry's Input fields that a template uses. */
interface RegistryInput {
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: McpInputFormat;
  default?: string;
  choices?: string[];
  /** Fixed: written as is and not shown as editable. */
  value?: string;
}

export interface RegistryArgument extends RegistryInput {
  type: "positional" | "named";
  /** Named arguments: the flag, such as `--db-path`. */
  name?: string;
  /** What the value is, such as `target_dir`. A named argument without one is a flag. */
  valueHint?: string;
}

export interface RegistryEnvironmentVariable extends RegistryInput {
  name: string;
}

export interface McpTemplatePackage {
  registryType: "npm" | "pypi" | "oci";
  /** An OCI identifier carries its tag, as in the registry. */
  identifier: string;
  /** npm and PyPI: the exact version. */
  version?: string;
  /** The day the version was checked against its registry, YYYY-MM-DD. */
  versionChecked: string;
  runtimeHint: "npx" | "uvx" | "docker";
  transport: { type: "stdio" };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryEnvironmentVariable[];
}

export interface McpTemplate {
  id: string;
  title: string;
  /** One line, at most 100 characters (the registry's own limit). */
  description: string;
  category: McpTemplateCategory;
  repository: string;
  package: McpTemplatePackage;
}

export interface McpTemplateFile {
  checked: string;
  templates: McpTemplate[];
}

/** One value the Simple (required) or Advanced (optional) screen asks for. */
export interface McpWizardField {
  /** Where the value goes. */
  target: "argument" | "env" | "header";
  /** The env or header name, a named argument's flag, or a positional argument's hint. */
  name: string;
  label: string;
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  format?: McpInputFormat;
  default?: string;
  choices?: string[];
  /**
   * An argument already in `draft.args`: the index its value goes to. When
   * absent, a filled-in optional argument is appended (`[name, value]` for a
   * named one, `[value]` for a positional one).
   */
  argIndex?: number;
  /** A value from the paste is held in core: the field shows it as set, never its text. */
  hasValue?: boolean;
}

export const MCP_TEMPLATES_FILE = data as McpTemplateFile;
export const MCP_TEMPLATES: readonly McpTemplate[] =
  MCP_TEMPLATES_FILE.templates;

const CATEGORIES = new Set<McpTemplateCategory>([
  "files",
  "developer",
  "web",
  "memory",
  "reasoning",
  "data",
]);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PYPI_VERSION = /^\d+(?:\.\d+)+$/;
const OCI_PINNED =
  /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+(?::v?\d+\.\d+\.\d+|@sha256:[0-9a-f]{64})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_FOR: Record<McpTemplatePackage["registryType"], string> = {
  npm: "npx",
  pypi: "uvx",
  oci: "docker",
};

function validDate(s: unknown): s is string {
  return typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(s));
}

function validateArgs(
  id: string,
  args: RegistryArgument[] | undefined,
): string[] {
  const errors: string[] = [];
  for (const a of args ?? []) {
    if (
      a.type === "named" &&
      !/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(a.name ?? "")
    ) {
      errors.push(`${id}: a named argument needs a flag such as --name.`);
    }
    if (a.type === "positional" && !a.valueHint && a.value === undefined) {
      errors.push(`${id}: a positional argument needs a valueHint or a value.`);
    }
    if (a.isSecret) {
      errors.push(
        `${id}: ${a.name ?? a.valueHint} is a secret argument; pass secrets in environmentVariables, where they become references.`,
      );
    }
  }
  return errors;
}

/** Every problem with one template; empty when it is valid. */
export function validateTemplate(t: McpTemplate, checked: string): string[] {
  const errors: string[] = [];
  const id = t.id || "(no id)";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.id ?? ""))
    errors.push(`${id}: the id must be a lowercase slug.`);
  if (!t.title?.trim()) errors.push(`${id}: no title.`);
  if (!t.description?.trim() || t.description.length > 100)
    errors.push(
      `${id}: the description must be one line of 1 to 100 characters.`,
    );
  if (!CATEGORIES.has(t.category))
    errors.push(`${id}: unknown category ${String(t.category)}.`);
  if (!/^https:\/\//.test(t.repository ?? ""))
    errors.push(`${id}: the repository must be an https:// URL.`);
  const p = t.package;
  if (!p) return [...errors, `${id}: no package.`];
  if (RUNTIME_FOR[p.registryType] !== p.runtimeHint)
    errors.push(
      `${id}: ${p.registryType} runs with ${RUNTIME_FOR[p.registryType] ?? "?"}, not ${p.runtimeHint}.`,
    );
  if (p.transport?.type !== "stdio")
    errors.push(`${id}: only stdio packages are bundled.`);
  if (p.registryType === "npm" && !SEMVER.test(p.version ?? ""))
    errors.push(`${id}: the npm version must be exact (x.y.z).`);
  if (p.registryType === "pypi" && !PYPI_VERSION.test(p.version ?? ""))
    errors.push(`${id}: the PyPI version must be exact.`);
  if (p.registryType === "oci" && (!OCI_PINNED.test(p.identifier) || p.version))
    errors.push(
      `${id}: the image must carry an exact tag or digest in its identifier.`,
    );
  if (!validDate(p.versionChecked))
    errors.push(`${id}: versionChecked must be a date (YYYY-MM-DD).`);
  else if (validDate(checked) && p.versionChecked > checked)
    errors.push(`${id}: versionChecked is later than the file's checked date.`);
  errors.push(...validateArgs(id, p.runtimeArguments));
  errors.push(...validateArgs(id, p.packageArguments));
  for (const e of p.environmentVariables ?? []) {
    if (!ENV_NAME.test(e.name))
      errors.push(`${id}: ${e.name} is not a valid variable name.`);
  }
  return errors;
}

/** Every problem in the bundled file; empty when it is valid. */
export function validateTemplates(
  file: McpTemplateFile = MCP_TEMPLATES_FILE,
): string[] {
  const errors: string[] = [];
  if (!validDate(file.checked)) errors.push("checked must be a date.");
  const seen = new Set<string>();
  for (const t of file.templates) {
    if (seen.has(t.id)) errors.push(`${t.id}: the id is used twice.`);
    seen.add(t.id);
    errors.push(...validateTemplate(t, file.checked));
  }
  return errors;
}

export function findTemplate(id: string): McpTemplate | undefined {
  return MCP_TEMPLATES.find((t) => t.id === id);
}

/** The package as the runner names it: `pkg@1.2.3`, or the image with its tag. */
export function templatePackageSpec(p: McpTemplatePackage): string {
  return p.registryType === "oci"
    ? p.identifier
    : `${p.identifier}@${p.version}`;
}

function label(text: string): string {
  const words = text.replace(/^-+/, "").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function inputField(
  input: RegistryInput,
  base: Pick<McpWizardField, "target" | "name" | "label">,
): McpWizardField {
  return {
    ...base,
    ...(input.description ? { description: input.description } : {}),
    isRequired: !!input.isRequired,
    isSecret: !!input.isSecret,
    ...(input.format ? { format: input.format } : {}),
    ...(input.default === undefined ? {} : { default: input.default }),
    ...(input.choices ? { choices: [...input.choices] } : {}),
  };
}

/** Append one registry argument to `args`; returns a field when it takes a value. */
function placeArgument(
  a: RegistryArgument,
  args: string[],
): McpWizardField | undefined {
  if (a.type === "named") {
    // A fixed value, or a flag without one
    if (a.value !== undefined || !a.valueHint) {
      args.push(a.name!, ...(a.value === undefined ? [] : [a.value]));
      return undefined;
    }
  } else if (a.value !== undefined) {
    args.push(a.value);
    return undefined;
  }
  const field = inputField(a, {
    target: "argument",
    name: a.type === "named" ? a.name! : a.valueHint!,
    label: label(a.valueHint!),
  });
  if (!a.isRequired) return field;
  if (a.type === "named") args.push(a.name!);
  args.push(a.default ?? "");
  return { ...field, argIndex: args.length - 1 };
}

/**
 * The template as a draft for the review screen, and the fields it needs.
 * A required argument's value is an empty string at `argIndex` until the
 * person fills it in; a required secret is an empty secret value.
 */
export function templateToDraft(t: McpTemplate): {
  draft: McpServerDraft;
  fields: McpWizardField[];
} {
  const p = t.package;
  const fields: McpWizardField[] = [];
  const args: string[] = [];
  let command: string;
  const envVars = p.environmentVariables ?? [];
  if (p.registryType === "oci") {
    command = "docker";
    args.push("run", "-i", "--rm");
    for (const a of p.runtimeArguments ?? []) {
      const f = placeArgument(a, args);
      if (f) fields.push(f);
    }
    // The container gets only the variables named here
    for (const e of envVars) args.push("-e", e.name);
    args.push(templatePackageSpec(p));
  } else {
    command = p.runtimeHint;
    if (p.registryType === "npm") args.push("-y");
    args.push(templatePackageSpec(p));
  }
  for (const a of p.packageArguments ?? []) {
    const f = placeArgument(a, args);
    if (f) fields.push(f);
  }
  const env: McpDraftValue[] = [];
  for (const e of envVars) {
    fields.push(inputField(e, { target: "env", name: e.name, label: e.name }));
    if (e.isRequired || e.value !== undefined || e.default !== undefined) {
      env.push({
        name: e.name,
        value: e.value ?? e.default ?? "",
        secret: !!e.isSecret,
      });
    }
  }
  return {
    draft: {
      name: t.id,
      transport: "stdio",
      command,
      args,
      ...(env.length ? { env } : {}),
    },
    fields,
  };
}

/** A template card for the Start step. */
export interface McpTemplateSummary {
  id: string;
  title: string;
  description: string;
  category: McpTemplateCategory;
  repository: string;
  runtimeHint: McpTemplatePackage["runtimeHint"];
  /** `pkg@1.2.3`, or the image with its tag. */
  pinned: string;
  versionChecked: string;
}

export function templateSummaries(): McpTemplateSummary[] {
  return MCP_TEMPLATES.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    category: t.category,
    repository: t.repository,
    runtimeHint: t.package.runtimeHint,
    pinned: templatePackageSpec(t.package),
    versionChecked: t.package.versionChecked,
  }));
}
