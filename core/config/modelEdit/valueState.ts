/**
 * For one setting of a model: the value in use, where it comes from, and the
 * sentence the dialog shows for it ("Set by you: 0.2", or "Not set: ..." with
 * what happens then).
 *
 * The value is read from the model as the config loader builds it: the
 * layers are combined by the loader's own functions (`resolveCatalogModels`,
 * then `resolveModelConnections`), so the dialog cannot disagree with what a
 * request is built from. Which layer a value came from is then the topmost
 * layer that wrote that same value. What applies when no layer wrote the key
 * comes from the field's `notSet` rule and from the facts of the loaded
 * model.
 *
 * No Node imports: the webview uses this.
 */
import {
  parseCatalogRef,
  resolveCatalogModels,
  resolveModelConnections,
  type CatalogModel,
  type ProviderInstance,
} from "@continuedev/config-yaml";
import {
  capabilityState,
  count,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_ROLES,
  getPath,
  MASK,
  NO_PRICE_KNOWN,
  notSetText,
  pathKey,
  usd,
  type ModelEditField,
  type ModelFacts,
  type NotSetContext,
} from "./modelEditFields";

/** The four places a model's settings are written, top first. */
export type ModelLayer = "entry" | "variant" | "catalog" | "account";

export interface ModelLayers {
  /** The config entry as written; `from: Name#variant` for a catalog model. */
  entry: Record<string, unknown>;
  /** The config file, as the dialog names it. */
  entryFile?: string;
  /** The catalog model the entry's `from:` names, with its variants (models.yaml). */
  catalogModel?: Record<string, unknown>;
  /** A file to open for the catalog model, when one is known. */
  catalogFile?: string;
  /** The provider account the model's `connection:` names (providers.yaml). */
  account?: Record<string, unknown>;
  /** A file to open for the account, when one is known. */
  accountFile?: string;
}

/** The one vocabulary for where a value comes from. */
export type ValueSourceKind =
  | "user"
  | "account"
  | "catalog"
  | "variant"
  | "server"
  | "provider"
  | "published"
  | "priceTable"
  | "detected"
  | "assumed"
  | "notSet";

export interface ResolvedValue {
  /** The value in use, when one can be shown. */
  value?: unknown;
  /** The value as text ("200,000", "on", "chat, edit"), when there is one. */
  valueText?: string;
  sourceKind: ValueSourceKind;
  /** "set by you", "account work", "catalog model", "variant plan", "published", ... */
  source: string;
  /** The file or layer behind the source: "config.yaml", "models.yaml". */
  sourceDetail?: string;
  /** The key is written in the config entry, the layer the dialog saves. */
  setByUser: boolean;
  /** The layer that wrote the value, and a file to open for it. */
  whereSet?: { layer: ModelLayer; name?: string; file?: string };
  /** The words after the state: "0.2", "0.6 from the account work", "7,200 s". */
  detail: string;
  /** "Set by you: 0.2", "Not set: 0.6 from the account work", "Not set: 7,200 s". */
  sentence: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The name of the variant a `from:` reference picks, if any. */
function variantOf(entry: Record<string, unknown>): string | undefined {
  return typeof entry.from === "string"
    ? parseCatalogRef(entry.from).variant
    : undefined;
}

/**
 * The model the loader builds from the layers: the catalog model, its
 * variant and the entry (`resolveCatalogModels`), then the account's
 * connection settings under it (`resolveModelConnections`). Undefined when
 * the loader would skip the model (an unknown catalog name or account).
 */
export function resolveModelEntry(
  layers: ModelLayers,
): Record<string, unknown> | undefined {
  const fromCatalog = resolveCatalogModels(
    [layers.entry],
    layers.catalogModel
      ? [layers.catalogModel as unknown as CatalogModel]
      : undefined,
  );
  const connected = resolveModelConnections(
    fromCatalog.models,
    layers.account
      ? [layers.account as unknown as ProviderInstance]
      : undefined,
  );
  const model = connected.models?.[0];
  return isRecord(model) ? model : undefined;
}

/**
 * A key as a layer wrote it. The window may also be written next to
 * maxTokens, which the loader reads when the root key is absent
 * (core/config/yaml/models.ts).
 */
function written(layer: unknown, path: readonly string[]): unknown {
  const value = getPath(layer, path);
  if (value !== undefined && value !== null) return value;
  if (pathKey(path) === "contextLength") {
    return (
      getPath(layer, ["defaultCompletionOptions", "contextLength"]) ?? undefined
    );
  }
  return undefined;
}

interface LayerHit {
  layer: ModelLayer;
  name?: string;
  file?: string;
}

/** The layers that can write a model key, top first, each with its fields. */
function layerList(
  layers: ModelLayers,
): (LayerHit & { fields: Record<string, unknown> | undefined })[] {
  const variant = variantOf(layers.entry);
  const catalogName =
    typeof layers.catalogModel?.name === "string"
      ? layers.catalogModel.name
      : undefined;
  const variants = layers.catalogModel?.variants;
  const { from: _from, ...own } = layers.entry;
  const {
    variants: _v,
    routes: _r,
    ...catalogBase
  } = layers.catalogModel ?? {};
  return [
    { layer: "entry", file: layers.entryFile, fields: own },
    {
      layer: "variant",
      name: variant,
      file: layers.catalogFile,
      fields:
        variant && isRecord(variants) && isRecord(variants[variant])
          ? (variants[variant] as Record<string, unknown>)
          : undefined,
    },
    {
      layer: "catalog",
      name: catalogName,
      file: layers.catalogFile,
      fields: layers.catalogModel ? catalogBase : undefined,
    },
    {
      layer: "account",
      name:
        typeof layers.account?.name === "string"
          ? layers.account.name
          : undefined,
      file: layers.accountFile,
      fields: layers.account,
    },
  ];
}

/** The topmost layer that wrote this value into the built model. */
function layerOf(
  layers: ModelLayers,
  path: readonly string[],
  value: unknown,
): LayerHit | undefined {
  for (const { fields, ...hit } of layerList(layers)) {
    const own = written(fields, path);
    if (own !== undefined && same(own, value)) return hit;
  }
  return undefined;
}

function baseName(file: string | undefined): string | undefined {
  return file ? file.split(/[\\/]/).pop() || undefined : undefined;
}

function sourceOf(hit: LayerHit): {
  sourceKind: ValueSourceKind;
  source: string;
  sourceDetail?: string;
} {
  switch (hit.layer) {
    case "entry":
      return {
        sourceKind: "user",
        source: "set by you",
        sourceDetail: baseName(hit.file) ?? "this config",
      };
    case "variant":
      return {
        sourceKind: "variant",
        source: `variant ${hit.name ?? ""}`.trim(),
        sourceDetail: baseName(hit.file) ?? "models.yaml",
      };
    case "catalog":
      return {
        sourceKind: "catalog",
        source: "catalog model",
        sourceDetail: hit.name,
      };
    case "account":
      return {
        sourceKind: "account",
        source: `account ${hit.name ?? ""}`.trim(),
        sourceDetail: baseName(hit.file) ?? "providers.yaml",
      };
  }
}

/** A written value as the dialog shows it. Credentials are never shown. */
export function valueText(field: ModelEditField, value: unknown): string {
  if (field.kind === "secretRef") return MASK;
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    return field.integer ? count(value) : String(value);
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "string") {
    const line = value.trim().split(/\r?\n/)[0];
    return line.length < value.trim().length ? `${line} ...` : line;
  }
  return String(value);
}

/** The two forms every setting is shown in. */
function stated(
  setByUser: boolean,
  detail: string,
): Pick<ResolvedValue, "detail" | "sentence"> {
  return {
    detail,
    sentence: `${setByUser ? "Set by you" : "Not set"}: ${detail}`,
  };
}

/** "from the account work", "from the catalog model", "from the variant plan". */
function inheritedFrom(hit: LayerHit): string {
  if (hit.layer === "account") return `from the account ${hit.name ?? ""}`;
  if (hit.layer === "variant") return `from the variant ${hit.name ?? ""}`;
  return "from the catalog model";
}

/** What is in use for a key no layer wrote, from the loaded model's facts. */
function unsetValue(
  key: string,
  c: NotSetContext,
): Pick<ResolvedValue, "value" | "valueText" | "sourceKind" | "source"> {
  const facts: ModelFacts = c.facts ?? {};
  const reported = c.local
    ? ({ sourceKind: "server", source: "from the server" } as const)
    : ({ sourceKind: "provider", source: "from the provider" } as const);
  const published = { sourceKind: "published", source: "published" } as const;
  const notSet = { sourceKind: "notSet", source: "not set" } as const;
  const number = (n: number) => ({ value: n, valueText: count(n) });

  switch (key) {
    case "contextLength":
      if (facts.contextLengthSource === "unknown") {
        return {
          ...number(DEFAULT_CONTEXT_WINDOW),
          sourceKind: "assumed",
          source: "assumed",
        };
      }
      if (facts.contextLength === undefined) return notSet;
      if (facts.contextLengthSource === "provider") {
        return { ...number(facts.contextLength), ...reported };
      }
      if (facts.contextLengthSource === "published") {
        return { ...number(facts.contextLength), ...published };
      }
      return notSet;
    case "defaultCompletionOptions.maxTokens":
      if (facts.maxTokens === undefined) return notSet;
      if (facts.maxTokensSource === "provider") {
        return { ...number(facts.maxTokens), ...reported };
      }
      if (facts.maxTokensSource === "published") {
        return { ...number(facts.maxTokens), ...published };
      }
      return { ...number(facts.maxTokens), ...notSet };
    case "roles":
      return {
        value: [...DEFAULT_ROLES],
        valueText: DEFAULT_ROLES.join(", "),
        ...notSet,
      };
    case "pricing.input":
    case "pricing.output": {
      const price = facts.tablePrice;
      if (!price || price === "unknown") return notSet;
      const n = key === "pricing.input" ? price.input : price.output;
      return {
        value: n,
        valueText: `$${usd(n)}`,
        sourceKind: "priceTable",
        source: "price table",
      };
    }
    case "promptTemplates.chat":
      return facts.chatTemplate
        ? {
            value: facts.chatTemplate,
            valueText: facts.chatTemplate,
            sourceKind: "detected",
            source: "detected",
          }
        : notSet;
    case "defaultCompletionOptions.reasoning":
      return facts.reasoningDetected
        ? {
            value: true,
            valueText: "on",
            sourceKind: "detected",
            source: "detected",
          }
        : notSet;
    default:
      return notSet;
  }
}

/**
 * One field of `MODEL_EDIT_FIELDS` for a model: its value in use, its source
 * and its sentence.
 */
export function resolvedValue(
  field: ModelEditField,
  layers: ModelLayers,
  context: NotSetContext,
): ResolvedValue {
  // A model the loader would skip still shows what its entry says
  const model = resolveModelEntry(layers) ?? layers.entry;
  const value = written(model, field.path);
  const hit =
    value === undefined ? undefined : layerOf(layers, field.path, value);

  if (value !== undefined && hit) {
    const text = valueText(field, value);
    const setByUser = hit.layer === "entry";
    return {
      value,
      valueText: text,
      ...sourceOf(hit),
      setByUser,
      whereSet: hit,
      ...stated(setByUser, setByUser ? text : `${text} ${inheritedFrom(hit)}`),
    };
  }

  return {
    ...unsetValue(pathKey(field.path), context),
    setByUser: false,
    ...stated(false, notSetText(field, context)),
  };
}

/**
 * Tool use or image input: written in the `capabilities` list of a layer, or
 * detected for the model.
 */
export function resolvedCapability(
  name: "tool_use" | "image_input",
  layers: ModelLayers,
  context: NotSetContext,
): ResolvedValue {
  const model = resolveModelEntry(layers) ?? layers.entry;
  const list = model.capabilities;
  const state = capabilityState(list, name);
  if (state !== "auto") {
    const text = state === "on" ? "yes" : "no";
    const hit = layerOf(layers, ["capabilities"], list) ?? {
      layer: "entry" as const,
    };
    const setByUser = hit.layer === "entry";
    return {
      value: state === "on",
      valueText: text,
      ...sourceOf(hit),
      setByUser,
      whereSet: hit,
      ...stated(setByUser, setByUser ? text : `${text} ${inheritedFrom(hit)}`),
    };
  }
  const detected =
    name === "tool_use" ? context.facts?.nativeTools : context.facts?.images;
  if (detected === undefined) {
    return {
      sourceKind: "notSet",
      source: "not set",
      setByUser: false,
      ...stated(false, "detected for the model"),
    };
  }
  const text = detected ? "yes" : "no";
  return {
    value: detected,
    valueText: text,
    sourceKind: "detected",
    source: "detected",
    setByUser: false,
    ...stated(false, `${text}, detected for the model`),
  };
}

/** The Overview's price row: input and output together, never $0 for unknown. */
export function priceSummary(
  input: ResolvedValue,
  output: ResolvedValue,
): { text: string; known: boolean } {
  if (typeof input.value !== "number" || typeof output.value !== "number") {
    return { text: NO_PRICE_KNOWN, known: false };
  }
  return {
    text: `$${usd(input.value)} / $${usd(output.value)}`,
    known: true,
  };
}

/**
 * The catalog model and the account behind a config entry, picked the way
 * the loader picks them: the catalog model its `from:` names, and the
 * account the built model ends up connected through (its own `connection`,
 * the catalog model's, or its first route).
 */
export function pickLayers(
  entry: Record<string, unknown>,
  catalogModels: readonly Record<string, unknown>[],
  accounts: readonly Record<string, unknown>[],
): Pick<ModelLayers, "catalogModel" | "account"> {
  const catalogModel =
    typeof entry.from === "string"
      ? catalogModels.find(
          (m) => m.name === parseCatalogRef(entry.from as string).name,
        )
      : undefined;
  const fromCatalog = resolveCatalogModels(
    [entry],
    catalogModel ? [catalogModel as unknown as CatalogModel] : undefined,
  );
  const connected = resolveModelConnections(
    fromCatalog.models,
    accounts as unknown as ProviderInstance[],
  );
  const model = connected.models?.[0];
  const connection = isRecord(model) ? model.connection : undefined;
  const account =
    typeof connection === "string"
      ? accounts.find((a) => a.name === connection)
      : undefined;
  return {
    ...(catalogModel ? { catalogModel } : {}),
    ...(account ? { account } : {}),
  };
}
