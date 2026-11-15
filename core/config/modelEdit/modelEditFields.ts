/**
 * The fields the model configuration dialog can change in a config.yaml model
 * entry, how each is validated, and how a patch from the dialog is applied.
 *
 * Kept free of Node imports so the webview can use it too: the dialog shows
 * the same field-level messages that core checks again before it writes.
 *
 * A patch only ever touches the paths listed here. Every other key of the
 * entry (and of the file) is left exactly as it was, and credentials are only
 * ever written as `${{ secrets.NAME }}` references.
 */
import {
  CHAT_TEMPLATE_VALUES,
  modelRolesSchema,
  TOOL_DIALECT_VALUES,
  toolOverrideSchema,
} from "@continuedev/config-yaml";
import { isValidSecretName } from "../../util/unresolvedSecrets";

export type ModelEditSection =
  "connection" | "capabilities" | "generation" | "templates" | "context";

export type FieldKind =
  | "text"
  /** Text over several lines, written as typed (a prompt, a template). */
  | "multiline"
  | "url"
  | "number"
  | "boolean"
  | "enum"
  | "list"
  | "secretRef";

export interface ModelEditField {
  /** Path inside the model entry, e.g. ["defaultCompletionOptions", "temperature"]. */
  path: string[];
  section: ModelEditSection;
  label: string;
  kind: FieldKind;
  /** What applies when the key is absent; shown as the placeholder, never written. */
  defaultText?: string;
  help?: string;
  required?: boolean;
  integer?: boolean;
  min?: number;
  /** `min` itself is not allowed. */
  minExclusive?: boolean;
  max?: number;
  options?: readonly string[];
  /** URL schemes accepted by a `url` field. */
  schemes?: readonly string[];
  /** Shown only for these providers, unless the entry already has the key. */
  providers?: readonly string[];
}

export const MODEL_ROLES: readonly string[] = modelRolesSchema.options;
export const DEFAULT_ROLES = ["chat", "edit", "apply", "summarize"] as const;
export const TOOL_DIALECTS: readonly string[] = TOOL_DIALECT_VALUES;
export const CHAT_TEMPLATES: readonly string[] = CHAT_TEMPLATE_VALUES;

/** `crossRegionInference` values: auto, or an inference profile prefix (bedrockHelpers). */
export const CROSS_REGION_VALUES = [
  "auto",
  "us",
  "us-gov",
  "eu",
  "apac",
  "jp",
  "au",
  "ca",
  "global",
] as const;

const HTTP = ["http:", "https:"] as const;
const AWS = ["bedrock", "bedrock-mantle", "sagemaker"] as const;

export const MODEL_EDIT_FIELDS: readonly ModelEditField[] = [
  // Connection
  {
    path: ["provider"],
    section: "connection",
    label: "Provider",
    kind: "text",
    help: "Required unless the model names a provider account with connection.",
  },
  {
    path: ["model"],
    section: "connection",
    label: "Model id",
    kind: "text",
    required: true,
    help: "The id the provider knows the model by.",
  },
  {
    path: ["apiBase"],
    section: "connection",
    label: "API base",
    kind: "url",
    schemes: HTTP,
    defaultText: "the provider's default",
  },
  {
    path: ["apiKey"],
    section: "connection",
    label: "API key",
    kind: "secretRef",
  },
  {
    path: ["env", "region"],
    section: "connection",
    label: "Region",
    kind: "text",
    providers: ["bedrock", "bedrock-mantle", "sagemaker", "vertexai"],
  },
  {
    path: ["env", "profile"],
    section: "connection",
    label: "AWS profile",
    kind: "text",
    providers: ["bedrock", "bedrock-mantle", "sagemaker"],
    defaultText: "the default credential chain",
  },
  {
    path: ["env", "accessKeyId"],
    section: "connection",
    label: "AWS access key id",
    kind: "secretRef",
    providers: AWS,
  },
  {
    path: ["env", "secretAccessKey"],
    section: "connection",
    label: "AWS secret access key",
    kind: "secretRef",
    providers: AWS,
  },
  {
    path: ["env", "sessionToken"],
    section: "connection",
    label: "AWS session token",
    kind: "secretRef",
    providers: AWS,
    help: "Only for temporary credentials.",
  },
  {
    path: ["env", "crossRegionInference"],
    section: "connection",
    label: "Cross-region inference",
    kind: "enum",
    options: CROSS_REGION_VALUES,
    providers: ["bedrock"],
    defaultText: "off, the model id as written",
    help: "Adds the inference profile prefix to the model id; auto picks it from the region.",
  },
  {
    path: ["env", "serviceTier"],
    section: "connection",
    label: "Service tier",
    kind: "enum",
    options: ["default", "priority", "flex", "reserved"],
    providers: ["bedrock"],
    defaultText: "default",
    help: "priority is faster at a higher price, flex cheaper and slower, reserved uses reserved capacity.",
  },
  {
    path: ["env", "latency"],
    section: "connection",
    label: "Latency mode",
    kind: "enum",
    options: ["standard", "optimized"],
    providers: ["bedrock"],
    defaultText: "standard",
    help: "optimized works only on the models and regions that offer it.",
  },
  {
    path: ["env", "guardrailIdentifier"],
    section: "connection",
    label: "Guardrail id or ARN",
    kind: "text",
    providers: ["bedrock"],
    defaultText: "none",
  },
  {
    path: ["env", "guardrailVersion"],
    section: "connection",
    label: "Guardrail version",
    kind: "text",
    providers: ["bedrock"],
    defaultText: "DRAFT",
  },
  {
    path: ["env", "projectId"],
    section: "connection",
    label: "Project id",
    kind: "text",
    providers: ["vertexai", "watsonx"],
  },
  {
    path: ["env", "deployment"],
    section: "connection",
    label: "Deployment",
    kind: "text",
    providers: ["azure"],
    defaultText: "the model id",
  },
  {
    path: ["env", "deploymentId"],
    section: "connection",
    label: "Deployment id",
    kind: "text",
    providers: ["watsonx"],
    defaultText: "none, the project id is used",
  },
  {
    path: ["env", "apiVersion"],
    section: "connection",
    label: "API version",
    kind: "text",
    providers: ["azure", "watsonx"],
  },
  {
    path: ["env", "apiType"],
    section: "connection",
    label: "API type",
    kind: "text",
    providers: ["azure"],
  },
  {
    path: ["requestOptions", "timeout"],
    section: "connection",
    label: "Request timeout (seconds)",
    kind: "number",
    min: 0,
    minExclusive: true,
    defaultText: "7200",
  },
  {
    path: ["requestOptions", "connectTimeout"],
    section: "connection",
    label: "Connect timeout (seconds)",
    kind: "number",
    min: 0,
    minExclusive: true,
    defaultText: "10",
  },
  {
    path: ["requestOptions", "proxy"],
    section: "connection",
    label: "Proxy",
    kind: "url",
    schemes: ["http:", "https:", "socks:", "socks4:", "socks5:"],
    defaultText: "HTTPS_PROXY / HTTP_PROXY from the environment",
  },
  {
    path: ["requestOptions", "noProxy"],
    section: "connection",
    label: "Hosts that skip the proxy",
    kind: "list",
    help: "One host per line.",
  },
  {
    path: ["requestOptions", "verifySsl"],
    section: "connection",
    label: "Verify TLS certificates",
    kind: "boolean",
    defaultText: "on",
  },
  {
    path: ["requestOptions", "useSystemCa"],
    section: "connection",
    label: "Trust the system certificate store",
    kind: "boolean",
    defaultText: "on for Windows and macOS, off for Linux",
  },
  {
    path: ["requestOptions", "caBundlePath"],
    section: "connection",
    label: "CA bundle files",
    kind: "list",
    help: "One path per line.",
  },
  // Capabilities
  {
    path: ["roles"],
    section: "capabilities",
    label: "Roles",
    kind: "list",
    options: MODEL_ROLES,
    defaultText: DEFAULT_ROLES.join(", "),
  },
  {
    path: ["toolDialect"],
    section: "capabilities",
    label: "Tool calls written as text",
    kind: "enum",
    options: TOOL_DIALECTS,
    defaultText: "auto",
  },
  // Generation defaults
  {
    path: ["defaultCompletionOptions", "temperature"],
    section: "generation",
    label: "Temperature",
    kind: "number",
    min: 0,
    max: 2,
  },
  {
    path: ["defaultCompletionOptions", "topP"],
    section: "generation",
    label: "Top P",
    kind: "number",
    min: 0,
    minExclusive: true,
    max: 1,
  },
  {
    path: ["defaultCompletionOptions", "topK"],
    section: "generation",
    label: "Top K",
    kind: "number",
    integer: true,
    min: 1,
  },
  {
    path: ["defaultCompletionOptions", "presencePenalty"],
    section: "generation",
    label: "Presence penalty",
    kind: "number",
    min: -2,
    max: 2,
  },
  {
    path: ["defaultCompletionOptions", "frequencyPenalty"],
    section: "generation",
    label: "Frequency penalty",
    kind: "number",
    min: -2,
    max: 2,
  },
  {
    path: ["defaultCompletionOptions", "maxTokens"],
    section: "generation",
    label: "Max output tokens",
    kind: "number",
    integer: true,
    min: 1,
  },
  {
    path: ["defaultCompletionOptions", "stop"],
    section: "generation",
    label: "Stop sequences",
    kind: "list",
    help: "One per line.",
  },
  {
    path: ["defaultCompletionOptions", "reasoning"],
    section: "generation",
    label: "Reasoning",
    kind: "boolean",
  },
  {
    path: ["defaultCompletionOptions", "reasoningBudgetTokens"],
    section: "generation",
    label: "Reasoning budget (tokens)",
    kind: "number",
    integer: true,
    min: 1,
  },
  // Templates and system message
  {
    path: ["chatOptions", "baseSystemMessage"],
    section: "templates",
    label: "Chat system message",
    kind: "multiline",
    defaultText: "the built-in chat system message",
  },
  {
    path: ["chatOptions", "baseAgentSystemMessage"],
    section: "templates",
    label: "Agent system message",
    kind: "multiline",
    defaultText: "the built-in agent system message",
  },
  {
    path: ["chatOptions", "basePlanSystemMessage"],
    section: "templates",
    label: "Plan system message",
    kind: "multiline",
    defaultText: "the built-in plan system message",
  },
  {
    path: ["promptTemplates", "chat"],
    section: "templates",
    label: "Chat template",
    kind: "enum",
    options: CHAT_TEMPLATES,
    defaultText: "detected from the model id",
    help: "Only for providers that send a raw prompt; chat APIs apply the model's own template.",
  },
  {
    path: ["promptTemplates", "edit"],
    section: "templates",
    label: "Edit prompt template",
    kind: "multiline",
    defaultText: "the built-in edit prompt",
  },
  {
    path: ["promptTemplates", "apply"],
    section: "templates",
    label: "Apply prompt template",
    kind: "multiline",
    defaultText: "the built-in apply prompt",
  },
  {
    path: ["promptTemplates", "autocomplete"],
    section: "templates",
    label: "Autocomplete prompt template",
    kind: "multiline",
    defaultText: "the template detected for the model",
  },
  // Context and cost
  {
    path: ["contextLength"],
    section: "context",
    label: "Context length (tokens)",
    kind: "number",
    integer: true,
    min: 1,
  },
  {
    path: ["defaultCompletionOptions", "promptCaching"],
    section: "context",
    label: "Prompt caching",
    kind: "boolean",
    help: "Off also overrides the cache settings below.",
  },
  {
    path: ["cacheBehavior", "cacheSystemMessage"],
    section: "context",
    label: "Cache the system prompt",
    kind: "boolean",
  },
  {
    path: ["cacheBehavior", "cacheConversation"],
    section: "context",
    label: "Cache the conversation",
    kind: "boolean",
  },
  {
    path: ["cacheBehavior", "ttl"],
    section: "context",
    label: "Cache lifetime",
    kind: "enum",
    options: ["auto", "5m", "1h"],
  },
  {
    path: ["pricing", "input"],
    section: "context",
    label: "Input price (USD per million tokens)",
    kind: "number",
    min: 0,
    defaultText: "the price table's, if it has one",
  },
  {
    path: ["pricing", "output"],
    section: "context",
    label: "Output price (USD per million tokens)",
    kind: "number",
    min: 0,
    defaultText: "the price table's, if it has one",
  },
  {
    path: ["pricing", "cacheRead"],
    section: "context",
    label: "Cache read price (USD per million tokens)",
    kind: "number",
    min: 0,
    defaultText: "the input price",
  },
  {
    path: ["pricing", "cacheWrite"],
    section: "context",
    label: "Cache write price (USD per million tokens)",
    kind: "number",
    min: 0,
    defaultText: "the input price",
  },
];

/** `chatOptions.toolOverrides.<tool>`: one tool's override, set as a whole. */
export function isToolOverridePath(path: readonly string[]): boolean {
  return (
    path.length === 3 &&
    path[0] === "chatOptions" &&
    path[1] === "toolOverrides" &&
    /^[A-Za-z0-9_.:-]+$/.test(path[2])
  );
}

/** Header names whose values are credentials: only a secret reference may be written. */
export const SENSITIVE_HEADER =
  /authorization|api[-_]?key|token|secret|cookie|password/i;
/** Keys anywhere in an entry whose plain values are never sent to the webview. */
export const SENSITIVE_KEY =
  /^(apiKey|accessKeyId|secretAccessKey|sessionToken|passphrase|password|token)$|authorization|api[-_]?key|secret|cookie|password/i;

const SECRET_REF = /^\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

export const pathKey = (path: readonly string[]) => path.join(".");

export function fieldFor(path: readonly string[]): ModelEditField | undefined {
  const key = pathKey(path);
  return MODEL_EDIT_FIELDS.find((f) => pathKey(f.path) === key);
}

/** `${{ secrets.NAME }}` -> NAME, or undefined for anything else. */
export function secretRefName(value: unknown): string | undefined {
  return typeof value === "string"
    ? SECRET_REF.exec(value.trim())?.[1]
    : undefined;
}

export function secretRef(name: string): string {
  return `\${{ secrets.${name} }}`;
}

/** Is this value a template reference of any kind (secrets, inputs, ...)? */
function isTemplate(value: string): boolean {
  return /^\$\{\{[^}]*\}\}$/.test(value.trim());
}

/** What the dialog is told about a credential: never its value. */
export type CredentialState =
  | { state: "none" }
  | { state: "secret"; secretName: string }
  /** A template that is not a secret, such as `${{ inputs.X }}`, shown as written. */
  | { state: "template"; text: string }
  /** Written in plain text in the file; the value is withheld. */
  | { state: "plaintext" };

export function credentialState(value: unknown): CredentialState {
  if (value === undefined || value === null || value === "") {
    return { state: "none" };
  }
  const name = secretRefName(value);
  if (name) return { state: "secret", secretName: name };
  if (typeof value === "string" && isTemplate(value)) {
    return { state: "template", text: value.trim() };
  }
  return { state: "plaintext" };
}

export const MASK = "••••••";

/**
 * A copy of the entry safe to hand to the webview: every plain value under a
 * credential-like key is replaced by MASK. References stay as written.
 */
export function maskEntry(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => maskEntry(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskEntry(v, k)]),
    );
  }
  if (
    key &&
    SENSITIVE_KEY.test(key) &&
    typeof value === "string" &&
    value !== "" &&
    !isTemplate(value)
  ) {
    return MASK;
  }
  return value;
}

/** Mask a plain credential value on one line of YAML text (for the diff view). */
export function maskYamlLine(line: string): string {
  const m = /^(\s*(?:-\s+)?["']?([^"':#]+?)["']?\s*:\s+)(.+?)(\s+#.*)?$/.exec(
    line,
  );
  if (!m) return line;
  const [, head, key, value, comment = ""] = m;
  if (!SENSITIVE_KEY.test(key.trim())) return line;
  const bare = value.replace(/^["']|["']$/g, "");
  if (isTemplate(bare) || bare === "" || /^[|>]/.test(bare)) return line;
  return `${head}${MASK}${comment}`;
}

/**
 * One change from the dialog. `path` must name a field above, a request
 * header (["requestOptions", "headers", NAME]) or the capabilities list.
 * `value: undefined` removes the key.
 */
export interface ModelPatchOp {
  path: string[];
  value?: unknown;
}

export interface FieldError {
  path: string[];
  message: string;
}

export function isAllowedPath(path: readonly string[]): boolean {
  if (fieldFor(path)) return true;
  if (path.length === 1 && path[0] === "capabilities") return true;
  if (isToolOverridePath(path)) return true;
  return (
    path.length === 3 &&
    path[0] === "requestOptions" &&
    path[1] === "headers" &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(path[2])
  );
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function numberError(f: ModelEditField, v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return "Enter a number.";
  if (f.integer && !Number.isInteger(v)) return "Enter a whole number.";
  if (f.min !== undefined) {
    if (f.minExclusive ? v <= f.min : v < f.min) {
      return f.minExclusive
        ? `Must be more than ${f.min}.`
        : `Must be ${f.min} or more.`;
    }
  }
  if (f.max !== undefined && v > f.max) return `Must be ${f.max} or less.`;
  return undefined;
}

/**
 * Paths that are not fields of the registry (a request header, the
 * capabilities list, one tool's override): the message, or undefined when
 * valid. `false` when the path is none of these.
 */
function validateOtherPath(
  path: readonly string[],
  value: unknown,
): string | undefined | false {
  if (path[0] === "requestOptions" && path[1] === "headers") {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return "A header value is text.";
    if (SENSITIVE_HEADER.test(path[2]) && !secretRefName(value)) {
      return `${path[2]} carries a credential: store it as a secret and use \${{ secrets.NAME }}.`;
    }
    return undefined;
  }
  if (path.length === 1 && path[0] === "capabilities") {
    if (value === undefined) return undefined;
    return Array.isArray(value) && value.every((c) => typeof c === "string")
      ? undefined
      : "Capabilities is a list of names.";
  }
  if (isToolOverridePath(path)) {
    if (value === undefined) return undefined;
    const parsed = toolOverrideSchema.safeParse(value);
    if (parsed.success) return undefined;
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return `${where}${issue.message}`;
  }
  return false;
}

/** The message for one field's new value, or undefined when it is valid. */
export function validateFieldValue(
  path: readonly string[],
  value: unknown,
): string | undefined {
  const other = validateOtherPath(path, value);
  if (other !== false) return other;
  const f = fieldFor(path);
  if (!f) return "This setting cannot be changed here.";
  if (value === undefined) {
    return f.required ? `${f.label} is required.` : undefined;
  }
  switch (f.kind) {
    case "text":
      if (typeof value !== "string") return "Enter text.";
      if (f.required && value.trim() === "") return `${f.label} is required.`;
      return undefined;
    case "multiline":
      return typeof value === "string" ? undefined : "Enter text.";
    case "url": {
      if (typeof value !== "string" || value.trim() === "") {
        return "Enter a URL.";
      }
      if (isTemplate(value)) return undefined;
      const url = value.includes("://") ? parseUrl(value.trim()) : undefined;
      if (!url) {
        return "Enter a full URL, such as https://host:port/v1.";
      }
      if (f.schemes && !f.schemes.includes(url.protocol)) {
        return `Use ${f.schemes.map((s) => s.replace(":", "://")).join(" or ")}.`;
      }
      if (url.username || url.password) {
        return "Do not put a user name or password in the URL.";
      }
      return undefined;
    }
    case "number":
      return numberError(f, value);
    case "boolean":
      return typeof value === "boolean" ? undefined : "Choose on or off.";
    case "enum":
      return typeof value === "string" && f.options?.includes(value)
        ? undefined
        : `Choose one of: ${f.options?.join(", ")}.`;
    case "list": {
      if (
        pathKey(f.path) === "requestOptions.caBundlePath" &&
        typeof value === "string"
      ) {
        return value.trim() ? undefined : "Enter a path.";
      }
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return "Enter one item per line.";
      }
      if (value.some((v) => v.trim() === "")) return "Remove the empty line.";
      if (f.options) {
        const bad = value.filter((v) => !f.options!.includes(v));
        if (bad.length) return `Unknown: ${bad.join(", ")}.`;
        if (value.length === 0) return "Pick at least one.";
      }
      return undefined;
    }
    case "secretRef": {
      if (typeof value !== "string") return "Choose a secret.";
      const name = secretRefName(value);
      if (!name) {
        return f.path[0] === "apiKey"
          ? "Keys are never written into config.yaml: store the key as a secret and refer to it."
          : `${f.label} is a credential and is never written into config.yaml: store it as a secret and refer to it.`;
      }
      return isValidSecretName(name)
        ? undefined
        : "A secret name is letters, digits and _, not starting with a digit.";
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply the patch to a copy of the entry. Parent maps are created as needed,
 * and a map left empty by a removal is removed too. Nothing outside the
 * patched paths changes.
 */
export function applyModelPatch(
  entry: Record<string, unknown>,
  ops: readonly ModelPatchOp[],
): { entry: Record<string, unknown>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const next = structuredClone(entry);
  for (const op of ops) {
    if (!Array.isArray(op.path) || !isAllowedPath(op.path)) {
      errors.push({
        path: op.path ?? [],
        message: "This setting cannot be changed here.",
      });
      continue;
    }
    const message = validateFieldValue(op.path, op.value);
    if (message) {
      errors.push({ path: op.path, message });
      continue;
    }
    setPath(next, op.path, op.value);
  }
  return { entry: next, errors };
}

function setPath(
  obj: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    if (value === undefined) delete obj[head];
    else obj[head] = value;
    return;
  }
  let child = obj[head];
  if (!isPlainObject(child)) {
    if (value === undefined) return;
    child = {};
    obj[head] = child;
  }
  setPath(child as Record<string, unknown>, rest, value);
  if (value === undefined && Object.keys(child as object).length === 0) {
    delete obj[head];
  }
}

export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

/** Does a managed path lie below `prefix`? The entry itself is `[]`. */
function hasManagedChild(prefix: readonly string[]): boolean {
  if (prefix.length === 0) return true;
  const key = pathKey(prefix);
  if (key === "requestOptions.headers" || key === "chatOptions.toolOverrides") {
    return true;
  }
  return MODEL_EDIT_FIELDS.some(
    (f) =>
      f.path.length > prefix.length && prefix.every((x, i) => f.path[i] === x),
  );
}

export interface EntryEditResult {
  ops: ModelPatchOp[];
  /** Paths that differ but cannot be changed here (dot-joined). */
  refused: string[];
}

/**
 * The patch that turns `before` into `after`, for the Advanced (YAML) tab.
 * Both are the entry as the dialog sees it (credentials masked), so a masked
 * value left alone is equal and produces no operation. A difference at a path
 * the dialog manages becomes an operation on that path, validated like any
 * other; a difference anywhere else is listed in `refused` and never
 * written. A map that appears or disappears is walked as an empty one, so
 * adding `pricing: {input: 1, output: 2}` is two operations.
 */
export function opsFromEntryEdit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): EntryEditResult {
  const ops: ModelPatchOp[] = [];
  const refused: string[] = [];
  const isMapOrAbsent = (v: unknown) => v === undefined || isPlainObject(v);
  const walk = (path: string[], a: unknown, b: unknown) => {
    if (path.length > 0 && isAllowedPath(path)) {
      if (!sameValue(a, b)) {
        ops.push(b === undefined ? { path } : { path, value: b });
      }
      return;
    }
    if (hasManagedChild(path) && isMapOrAbsent(a) && isMapOrAbsent(b)) {
      const ao = (a ?? {}) as Record<string, unknown>;
      const bo = (b ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
        walk([...path, k], ao[k], bo[k]);
      }
      return;
    }
    if (!sameValue(a, b)) refused.push(pathKey(path));
  };
  walk([], before, after);
  return { ops, refused };
}

/** Capability names the dialog sets; any other name in the list is kept as it is. */
export const DIALOG_CAPABILITIES = ["tool_use", "image_input"] as const;

export type TriState = "auto" | "on" | "off";

/**
 * The `capabilities` list for the dialog's two choices, keeping names the
 * dialog does not manage (next_edit, or a name a newer version knows).
 * Undefined when both are auto and nothing else is listed: the key is then
 * removed and both are detected again.
 */
export function capabilitiesFor(
  current: unknown,
  tools: TriState,
  images: TriState,
): { value: string[] | undefined; error?: string } {
  const others = Array.isArray(current)
    ? current.filter(
        (c): c is string =>
          typeof c === "string" &&
          !(DIALOG_CAPABILITIES as readonly string[]).includes(c),
      )
    : [];
  if (tools === "auto" && images === "auto" && others.length === 0) {
    return { value: undefined };
  }
  if (tools === "auto" || images === "auto") {
    return {
      value: undefined,
      error:
        others.length > 0
          ? `capabilities also lists ${others.join(", ")}, so tool use and image input must each be set to yes or no.`
          : "Capabilities is one list: once one of these is set by hand, set the other by hand too, or set both to auto-detect.",
    };
  }
  const value = [
    ...(tools === "on" ? ["tool_use"] : []),
    ...(images === "on" ? ["image_input"] : []),
    ...others,
  ];
  return { value };
}

/** The dialog's tri-state for one capability, read from the entry. */
export function capabilityState(current: unknown, name: string): TriState {
  if (!Array.isArray(current)) return "auto";
  return current.includes(name) ? "on" : "off";
}

/**
 * Checks that need the whole entry: a provider is required unless the model
 * names a provider account (`connection:`), which supplies it.
 */
export function validateEntry(entry: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  const provider = entry.provider;
  const hasConnection =
    typeof entry.connection === "string" && entry.connection !== "";
  if (
    !hasConnection &&
    (typeof provider !== "string" || provider.trim() === "")
  ) {
    errors.push({ path: ["provider"], message: "Provider is required." });
  }
  return errors;
}
