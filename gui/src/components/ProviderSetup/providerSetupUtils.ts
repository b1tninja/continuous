import { fieldFor } from "core/config/modelEdit/modelEditFields";
import type {
  KeyStorage,
  ProviderConnectionKey,
  ProviderSetupConnection,
  ProviderSetupModel,
  SaveProviderModelsRequest,
  SetupRequestOptions,
  SetupSelectRole,
} from "core/config/providerSetup";
import { isRecommendedForAutocomplete } from "core/llm/completionModels";
import {
  connectionFailureKind,
  describeLocalServerFailure,
} from "core/llm/localServerError";
import { connectionTestDefaultBase } from "core/util/anthropicSurfaceTest";
import { contextLengthOverride } from "../ModelConfig/ContextLengthControl";
import { buildModelFromForm, FormValues } from "../../forms/addModelFormUtils";
import type { ModelLists } from "../../forms/modelListUtils";
import type { ModelPackage } from "../../pages/AddNewModel/configs/models";
import type { ProviderInfo } from "../../pages/AddNewModel/configs/providers";
import { fuzzyScore } from "../modelSelection/ModelSelectionListbox";

/**
 * "start" asks what the person has; then the one path every answer takes:
 * the connection, the models, what to use them for, and the review.
 */
export type SetupStep =
  "start" | "credentials" | "models" | "useFor" | "review";

/** The steps that are counted ("Step 2 of 4"); the start screen is before them. */
export const NUMBERED_STEPS: SetupStep[] = [
  "credentials",
  "models",
  "useFor",
  "review",
];

/** How many curated "popular" models start checked for a new provider. */
export const DEFAULT_CHECKED_COUNT = 3;

/** One line of the model checklist. */
export interface ChecklistRow {
  /** The provider's model id; the identity used to match configured models. */
  model: string;
  title: string;
  description?: string;
  /** In config.yaml already (so it can be removed). */
  configured: boolean;
  /** Absent for a configured model the provider's list does not offer. */
  pkg?: ModelPackage;
  deprecated?: boolean;
  /** Bedrock: won't work until the account fills out Anthropic's use-case form. */
  needsAnthropicUseCase?: boolean;
  /** Bedrock: why the account cannot use the model yet (needs access, pending, legacy). */
  accessNote?: string;
}

export interface ChecklistGroups {
  top: ChecklistRow[];
  other: ChecklistRow[];
  /** Configured models the current list does not include. */
  configuredOnly: ChecklistRow[];
}

function rowOf(pkg: ModelPackage, configured: Set<string>): ChecklistRow {
  return {
    model: pkg.params.model,
    title: pkg.title,
    description: pkg.description,
    configured: configured.has(pkg.params.model),
    pkg,
    deprecated: pkg.deprecated,
    needsAnthropicUseCase: pkg.needsAnthropicUseCase,
    accessNote: pkg.accessNote,
  };
}

/**
 * Rows for the checklist: the provider's list, plus configured models it does
 * not offer (a custom id, a model the provider has retired) so that unchecking
 * them is the only way they are removed.
 */
export function buildChecklistRows(
  lists: Pick<ModelLists, "top" | "other">,
  configuredModels: ProviderSetupModel[],
): ChecklistGroups {
  const configured = new Set(configuredModels.map((m) => m.model));
  const top = lists.top.map((p) => rowOf(p, configured));
  const other = (lists.other ?? []).map((p) => rowOf(p, configured));
  const offered = new Set([...top, ...other].map((r) => r.model));
  const configuredOnly = configuredModels
    .filter((m) => !offered.has(m.model))
    .map<ChecklistRow>((m) => ({
      model: m.model,
      title: m.name,
      description: m.model,
      configured: true,
    }));
  return { top, other, configuredOnly };
}

/**
 * Checked at the start: everything already configured; for a provider with
 * nothing configured, the first few popular models.
 */
export function initialChecked(
  groups: ChecklistGroups,
  configuredModels: ProviderSetupModel[],
  count = DEFAULT_CHECKED_COUNT,
): Set<string> {
  if (configuredModels.length > 0) {
    return new Set(configuredModels.map((m) => m.model));
  }
  return new Set(
    groups.top
      .filter((r) => !r.deprecated && !r.needsAnthropicUseCase && !r.accessNote)
      .slice(0, count)
      .map((r) => r.model),
  );
}

/** Rows matching a search, best match first. An empty query keeps the order. */
export function filterRows(
  rows: ChecklistRow[],
  query: string,
): ChecklistRow[] {
  const q = query.trim();
  if (!q) return rows;
  return rows
    .map((row) => ({
      row,
      score: Math.max(fuzzyScore(q, row.title), fuzzyScore(q, row.model) * 0.8),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row);
}

export interface SelectionDiff {
  add: ChecklistRow[];
  /** Configured models that are now unchecked. */
  remove: ProviderSetupModel[];
  /** Configured models that stay. */
  keep: ProviderSetupModel[];
}

export function diffSelection(
  groups: ChecklistGroups,
  configuredModels: ProviderSetupModel[],
  checked: Set<string>,
): SelectionDiff {
  const configured = new Set(configuredModels.map((m) => m.model));
  const all = [...groups.top, ...groups.other, ...groups.configuredOnly];
  const seen = new Set<string>();
  const add = all.filter((row) => {
    if (seen.has(row.model)) return false;
    seen.add(row.model);
    return checked.has(row.model) && !configured.has(row.model);
  });
  return {
    add,
    remove: configuredModels.filter((m) => !checked.has(m.model)),
    keep: configuredModels.filter((m) => checked.has(m.model)),
  };
}

export interface KeyChoice {
  storage: KeyStorage;
  secretName: string;
  /** Empty means "keep what is stored". */
  value: string;
}

export const KEY_STORAGE_LABELS: Record<KeyStorage, string> = {
  secure: "Secure storage (this editor)",
  env: "~/.continuous/.env file",
  envVar: "Environment variable (nothing is stored)",
  inline: "Inside config.yaml (not recommended)",
};

export function keyStorageOptions(
  secureAvailable: boolean,
): { value: KeyStorage; label: string }[] {
  const order: KeyStorage[] = secureAvailable
    ? ["secure", "env", "envVar", "inline"]
    : ["env", "envVar", "inline"];
  return order.map((value) => ({ value, label: KEY_STORAGE_LABELS[value] }));
}

/** Environment variable names: letters, digits, underscores; no leading digit. */
export function isValidSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Why the key section cannot be submitted, or undefined when it can. */
export function keyProblem(
  choice: KeyChoice,
  options: { keyRequired: boolean },
): string | undefined {
  if (choice.storage !== "inline" && !isValidSecretName(choice.secretName)) {
    return "Use letters, digits and underscores only, not starting with a digit";
  }
  if (choice.storage === "envVar") return undefined;
  if (
    choice.value === "" &&
    (options.keyRequired || choice.storage === "inline")
  ) {
    return "Enter the key";
  }
  return undefined;
}

/** The connection a form describes, in the form core matches entries by. */
export function connectionFromModel(
  model: Record<string, any>,
): ProviderConnectionKey {
  const connection: ProviderConnectionKey = {};
  for (const key of ["apiBase", "region", "profile"] as const) {
    const value = model[key];
    if (typeof value === "string" && value.trim() !== "") {
      connection[key] = value.trim();
    }
  }
  return connection;
}

/** Same connection as an existing one (what core calls the same endpoint). */
export function sameConnection(
  a: ProviderConnectionKey,
  b: ProviderConnectionKey,
): boolean {
  const norm = (c: ProviderConnectionKey) =>
    [
      c.apiBase?.replace(/\/+$/, "") ?? "",
      c.region ?? "",
      c.profile ?? "",
    ].join("|");
  return norm(a) === norm(b);
}

/** True for OpenAI's own API, false for any other OpenAI-compatible server. */
export function isOpenAICloud(apiBase: string): boolean {
  try {
    return new URL(apiBase).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/** The configured connection of a provider that matches the form's values. */
export function findConnection(
  connections: ProviderSetupConnection[],
  provider: string,
  connection: ProviderConnectionKey,
): ProviderSetupConnection | undefined {
  return connections.find(
    (c) => c.provider === provider && sameConnection(c.connection, connection),
  );
}

/**
 * The configured connection that serves the model with this picker title
 * (the `name` in config.yaml), for opening the setup flow where that model
 * lives. Undefined when no connection lists it.
 */
export function connectionForModel(
  connections: ProviderSetupConnection[],
  title: string | undefined,
): ProviderSetupConnection | undefined {
  if (!title) return undefined;
  return connections.find((c) => c.models.some((m) => m.name === title));
}

/** "http://localhost:1234/v1", "us-east-1 (work)" or "default endpoint". */
export function describeConnection(c: ProviderConnectionKey): string {
  const parts = [c.apiBase, c.region, c.profile ? `(${c.profile})` : undefined];
  const text = parts.filter(Boolean).join(" ");
  return text || "default endpoint";
}

export interface BuildRequestArgs {
  provider: ProviderInfo;
  /**
   * The connection being edited, as it is in config.yaml now. When the form
   * describes a different endpoint, core changes that connection in place.
   */
  editing?: ProviderConnectionKey;
  values: FormValues;
  diff: SelectionDiff;
  /** Whether to send the key section at all. */
  key?: KeyChoice;
  /** Live Bedrock titles ("... (Bedrock)") are used as the name. */
  useLiveTitles?: boolean;
  /**
   * Save as a provider account with catalog models (and `from:` entries in
   * the config) instead of models that carry their own connection. `name`
   * is a suggestion for a new account.
   */
  account?: { name?: string };
  /** Typed context-length overrides from the model step. Empty keeps the published window. */
  windows?: Record<string, string>;
  /**
   * The address typed under "More", for a provider whose form has no address
   * field of its own. Empty means the provider's own address, and no key.
   */
  apiBase?: string;
  /** The roles ticked in "Use for". Undefined when no model is added. */
  useFor?: ReadonlySet<SetupSelectRole>;
  /** What was set under "More"; unset fields are not in it. */
  requestOptions?: SetupRequestOptions;
}

/**
 * The `config/saveProviderModels` request for a finished flow. The key goes
 * into `key` only and never into the model descriptions.
 */
export function buildSaveRequest({
  provider,
  editing,
  values,
  diff,
  key,
  useLiveTitles,
  account,
  windows,
  apiBase,
  useFor,
  requestOptions,
}: BuildRequestArgs): SaveProviderModelsRequest {
  const moreBase = apiBase?.trim();
  const withBase = <T extends Record<string, any>>(model: T): T =>
    moreBase && !model.apiBase ? { ...model, apiBase: moreBase } : model;
  const contextWindows = Object.entries(windows ?? {}).flatMap(
    ([model, raw]) => {
      const contextLength = contextLengthOverride(raw);
      return contextLength === undefined ? [] : [{ model, contextLength }];
    },
  );
  const byModel = new Map(
    contextWindows.map((w) => [w.model, w.contextLength]),
  );
  const add = diff.add
    .filter((row) => row.pkg)
    .map((row) => {
      const pkg = row.pkg!;
      const model = withBase(
        buildModelFromForm(
          provider,
          pkg,
          { ...values, apiKey: undefined },
          { title: useLiveTitles ? pkg.params.title : undefined },
        ),
      );
      delete model.apiKey;
      const override = byModel.get(pkg.params.model);
      if (override !== undefined) model.contextLength = override;
      return model;
    });

  const connection = connectionFromModel(
    add[0] ??
      withBase(
        buildModelFromForm(
          provider,
          provider.packages[0],
          { ...values, apiKey: undefined },
          {},
        ),
      ),
  );

  const request: SaveProviderModelsRequest = {
    provider: provider.provider,
    connection,
    add,
    remove: diff.remove.map((m) => m.name),
  };
  if (editing && !sameConnection(editing, connection)) {
    request.from = editing;
  }
  if (account) request.account = account;
  if (contextWindows.length > 0) request.contextWindows = contextWindows;
  if (useFor && add.length > 0) {
    const roles = rolesToWrite(useFor);
    if (roles) request.roles = roles;
    const selectFor = USE_FOR.map((u) => u.role).filter((r) => useFor.has(r));
    if (selectFor.length > 0) request.selectFor = selectFor;
  }
  if (requestOptions && Object.keys(requestOptions).length > 0) {
    request.requestOptions = requestOptions;
  }
  if (key) {
    request.key = {
      storage: key.storage,
      ...(key.storage === "inline" ? {} : { secretName: key.secretName }),
      ...(key.storage !== "envVar" && key.value !== ""
        ? { value: key.value }
        : {}),
    };
  }
  return request;
}

/** One sentence for the review step about where the key goes. */
export function describeKeyPlan(
  key: KeyChoice | undefined,
  providerTitle: string,
): string {
  if (!key) return `The ${providerTitle} key stays as it is.`;
  switch (key.storage) {
    case "secure":
      return key.value
        ? `The ${providerTitle} key is saved in this editor's secure storage as ${key.secretName}. config.yaml only refers to it.`
        : `Models refer to ${key.secretName} in secure storage.`;
    case "env":
      return key.value
        ? `The ${providerTitle} key is saved in ~/.continuous/.env as ${key.secretName}. config.yaml only refers to it.`
        : `Models refer to ${key.secretName} in ~/.continuous/.env.`;
    case "envVar":
      return `Models refer to the environment variable ${key.secretName}. Nothing is stored; set it before starting the editor.`;
    case "inline":
      return `The ${providerTitle} key is written into config.yaml.`;
  }
}

/** The roles "Use for" offers, in the order shown, each with what it does. */
export const USE_FOR: { role: SetupSelectRole; label: string; what: string }[] =
  [
    { role: "chat", label: "Chat", what: "answers in Chat, Plan and Agent" },
    { role: "edit", label: "Edit", what: "rewrites the code you select" },
    {
      role: "apply",
      label: "Apply",
      what: "writes a suggested change into the file",
    },
    {
      role: "autocomplete",
      label: "Autocomplete",
      what: "completes code as you type",
    },
  ];

const BASE_USE_FOR: SetupSelectRole[] = ["chat", "edit", "apply"];

/**
 * What is ticked before the person changes anything: Chat, Edit and Apply,
 * and Autocomplete only when the catalogue recommends every model being
 * added for it (isRecommendedForAutocomplete; a chat model is not).
 */
export function defaultUseFor(
  provider: string,
  models: string[],
): Set<SetupSelectRole> {
  const completion =
    models.length > 0 &&
    models.every((m) => isRecommendedForAutocomplete(m, provider));
  return new Set(completion ? [...BASE_USE_FOR, "autocomplete"] : BASE_USE_FOR);
}

/** The first model the catalogue does not recommend for autocomplete, if any. */
export function notACompletionModel(
  provider: string,
  models: { model: string; title: string }[],
): string | undefined {
  return models.find((m) => !isRecommendedForAutocomplete(m.model, provider))
    ?.title;
}

/**
 * The `roles` to write for the ticks, or undefined when they are Chat, Edit
 * and Apply: a model with no `roles` key has those (and summarize), so
 * nothing is written. Any other choice is written out, and keeps summarize
 * with Chat, as an entry without the key would have it.
 */
export function rolesToWrite(
  useFor: ReadonlySet<SetupSelectRole>,
): string[] | undefined {
  const isBase =
    useFor.size === BASE_USE_FOR.length &&
    BASE_USE_FOR.every((r) => useFor.has(r));
  if (isBase) return undefined;
  const roles: string[] = USE_FOR.map((u) => u.role).filter((r) =>
    useFor.has(r),
  );
  return useFor.has("chat") ? [...roles, "summarize"] : roles;
}

/** One line of "Use for": what the role uses now and what it will use. */
export function useForLine(
  ticked: boolean,
  current: string | undefined,
  next: string,
): string {
  if (!ticked) {
    return current ? `stays ${current}` : "nothing chosen, and stays so";
  }
  if (!current) return `nothing chosen yet → will be ${next}`;
  if (current === next) return `stays ${current}`;
  return `currently ${current} → will be ${next}`;
}

/** The fields of the "More" fold that become `requestOptions`, as typed. */
export interface MoreOptionsForm {
  timeout: string;
  connectTimeout: string;
  proxy: string;
  verifySsl: "" | "on" | "off";
  useSystemCa: "" | "on" | "off";
  /** One path per line. */
  caBundlePath: string;
}

export const EMPTY_MORE_OPTIONS: MoreOptionsForm = {
  timeout: "",
  connectTimeout: "",
  proxy: "",
  verifySsl: "",
  useSystemCa: "",
  caBundlePath: "",
};

const defaultTextOf = (key: string) =>
  fieldFor(["requestOptions", key])?.defaultText;

/** "7,200 s" from the field table's "7200". */
function seconds(text: string | undefined): string {
  const n = Number(text);
  return Number.isFinite(n) ? `${n.toLocaleString("en-US")} s` : `${text} s`;
}

/**
 * What applies when a "More" field is not set, from the same table the
 * Configure dialog reads (core/config/modelEdit/modelEditFields.ts), whose
 * values are the code's own: 7,200 s is `TIMEOUT` in
 * packages/fetch/src/getAgentOptions.ts and 10 s is
 * `DEFAULT_CONNECT_TIMEOUT_SECONDS` in packages/fetch/src/connectTimeout.ts.
 */
export const MORE_NOT_SET = {
  timeout: seconds(defaultTextOf("timeout")),
  connectTimeout: seconds(defaultTextOf("connectTimeout")),
  proxy: defaultTextOf("proxy") ?? "no proxy",
  verifySsl: defaultTextOf("verifySsl") ?? "on",
  useSystemCa: defaultTextOf("useSystemCa") ?? "on",
  // No file is read unless one is named (CertsCache.getCa in packages/fetch)
  caBundlePath: "none",
} as const;

/** The address requests go to when no API base is set, where the code knows it. */
export function notSetApiBase(provider: string): string {
  return (
    connectionTestDefaultBase(provider) ??
    "the provider's own address, built into Continuous"
  );
}

/** Why a typed timeout cannot be used, or undefined. */
export function timeoutProblem(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n > 0
    ? undefined
    : "Enter a number of seconds above 0";
}

/** The request options that were set; a field left alone is not in it. */
export function requestOptionsFromForm(
  form: MoreOptionsForm,
): SetupRequestOptions {
  const out: SetupRequestOptions = {};
  for (const key of ["timeout", "connectTimeout"] as const) {
    if (form[key].trim() !== "" && !timeoutProblem(form[key])) {
      out[key] = Number(form[key]);
    }
  }
  if (form.proxy.trim() !== "") out.proxy = form.proxy.trim();
  if (form.verifySsl !== "") out.verifySsl = form.verifySsl === "on";
  if (form.useSystemCa !== "") out.useSystemCa = form.useSystemCa === "on";
  const paths = form.caBundlePath
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length > 0) out.caBundlePath = paths;
  return out;
}

/**
 * A failed test in the words the local-server helper uses
 * (core/llm/localServerError.ts), when the address is on this computer or
 * this network and no answer came at all. Anything else is kept as it is: a
 * rejected key or a 404 already says what happened.
 */
export function plainConnectionFailure(
  target: { provider: string; apiBase?: string },
  error: string,
): string {
  // The tester writes "Could not reach <url>: <reason>."
  const reason = /^Could not reach \S+: (.*)\.$/.exec(error)?.[1];
  if (reason === undefined) return error;
  const kind =
    reason === "timed out"
      ? "timed-out"
      : (connectionFailureKind(new Error(reason)) ?? "failed");
  return describeLocalServerFailure(target, kind) ?? error;
}
