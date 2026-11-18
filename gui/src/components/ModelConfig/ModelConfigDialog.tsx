import type { ToolDialectSetting } from "@continuedev/config-yaml";
import type { ModelDescription, Tool, ToolOverride } from "core";
import { defaultSecretName } from "core/config/providerSecretName";
import { parseEntryYaml } from "core/config/modelEdit/entryYaml";
import type {
  DiffLine,
  ModelBlockInfo,
} from "core/config/modelEdit/modelBlockEdit";
import {
  getPath,
  MODEL_EDIT_FIELDS,
  MODEL_ROLES,
  DEFAULT_ROLES,
  opsFromEntryEdit,
  pathKey,
  type EntryEditResult,
  type ModelEditField,
  type ModelEditSection,
  type ModelPatchOp,
  type TriState,
} from "core/config/modelEdit/modelEditFields";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { formatPriceSource } from "core/llm/utils/priceSourceText";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { hasConnectionTest } from "core/util/anthropicSurfaceTest";
import { costOf } from "core/util/costOf";
import { USER_PRICE_SOURCE, userPriceOf } from "core/util/modelPrice";
import { providerRecoversText } from "core/util/toolDialectLeak";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { BedrockConnectionTester } from "../../forms/BedrockConnectionTester";
import { FormSelect } from "../../forms/FormSelect";
import { OpenAICompatConnectionTester } from "../../forms/OpenAICompatConnectionTester";
import { useAppSelector } from "../../redux/hooks";
import { Button } from "../ui";
import {
  fieldError,
  formFromBlock,
  formToOps,
  headerIsSensitive,
  mergeOps,
  overrideValue,
  SECRET_FIELDS,
  secretsToStore,
  visibleFields,
  type BoolChoice,
  type HeaderRow,
  type KeyChoice,
  type ModelForm,
  type SecretToStore,
  type ToolOverrideRow,
} from "./modelConfigForm";
import {
  chatTemplatePreview,
  DEFAULT_SYSTEM_MESSAGES,
  renderTemplatePreview,
  TEMPLATE_VARIABLES,
  type PromptTemplateKind,
} from "./templatePreview";
import {
  DIALECT_INFO,
  presetHint,
  SAMPLE_TOOL_NAME,
  toolPromptPreview,
} from "./toolPreview";
import { useFocusTrap } from "./useFocusTrap";

type Tab = ModelEditSection | "advanced";

const TABS: { id: Tab; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "capabilities", label: "Capabilities" },
  { id: "generation", label: "Generation" },
  { id: "templates", label: "Templates & system message" },
  { id: "context", label: "Context & cost" },
  { id: "advanced", label: "Advanced (YAML)" },
];

const inputClass =
  "w-full rounded-default border border-solid border-input-border bg-input px-2 py-1 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-border-focus aria-[invalid=true]:border-error";

/** Which tab shows the field at this path (for jumping to an error). */
function tabOf(key: string): Tab {
  if (key === "capabilities") return "capabilities";
  if (key === "apiKey" || key.startsWith("requestOptions.headers")) {
    return "connection";
  }
  if (key.startsWith("chatOptions.toolOverrides")) return "templates";
  const f = MODEL_EDIT_FIELDS.find((x) => pathKey(x.path) === key);
  return f?.section ?? "connection";
}

function findLoadedModel(
  byRole: Record<string, ModelDescription[] | undefined> | undefined,
  title: string,
): ModelDescription | undefined {
  for (const models of Object.values(byRole ?? {})) {
    const hit = models?.find((m) => m.title === title);
    if (hit) return hit;
  }
  return undefined;
}

/** "accessKeyId" -> "ACCESS_KEY_ID" */
function upperSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

interface YamlEdit extends EntryEditResult {
  /** Set when the text is not a YAML map. */
  error?: string;
}

const NO_YAML_EDIT: YamlEdit = { ops: [], refused: [] };

interface Props {
  /** The model's name in config.yaml (its title in the GUI). */
  title: string;
  onDone: () => void;
  onCancel: () => void;
  /** Open the file the model is defined in. */
  onOpenFile: () => void;
}

/**
 * "Configure..." for one model: view and change the settings config.yaml
 * already has for it, review the YAML change, and save it with comments and
 * every other key kept. Credentials are only ever written as secret
 * references.
 */
export function ModelConfigDialog({
  title,
  onDone,
  onCancel,
  onOpenFile,
}: Props) {
  const ideMessenger = useContext(IdeMessengerContext);
  const titleId = useId();
  const config = useAppSelector((s) => s.config.config);
  const loaded = findLoadedModel(
    config.modelsByRole as Record<string, ModelDescription[]>,
    title,
  );

  const [info, setInfo] = useState<ModelBlockInfo>();
  const [loadError, setLoadError] = useState<string>();
  const [initial, setInitial] = useState<ModelForm>();
  const [form, setForm] = useState<ModelForm>();
  const [tab, setTab] = useState<Tab>("connection");
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Error keys that came from the Advanced tab's text, shown there. */
  const [yamlErrorKeys, setYamlErrorKeys] = useState<Set<string>>(new Set());
  const [yamlText, setYamlText] = useState<string>();
  const [review, setReview] = useState<{
    ops: ModelPatchOp[];
    diff: DiffLine[];
    baseHash: string;
    stores: SecretToStore[];
  }>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep Tab inside the dialog; the app's dialog container does not
  useFocusTrap(rootRef);
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus();
  }, []);

  useEffect(() => {
    let live = true;
    void ideMessenger.request("config/getModelBlock", { title }).then((res) => {
      if (!live) return;
      if (res.status !== "success") {
        setLoadError(String(res.error ?? "Could not read the config."));
        return;
      }
      setInfo(res.content);
      if (res.content.editable) {
        const f = formFromBlock(res.content);
        setInitial(f);
        setForm(f);
      }
    });
    return () => {
      live = false;
    };
  }, [ideMessenger, title]);

  const ready = form !== undefined;
  useEffect(() => {
    if (ready) tabRefs.current.connection?.focus();
  }, [ready]);

  const yamlEdit: YamlEdit = useMemo(() => {
    if (yamlText === undefined || !info?.entry || yamlText === info.entryYaml) {
      return NO_YAML_EDIT;
    }
    const parsed = parseEntryYaml(yamlText);
    if (!parsed.ok) return { ...NO_YAML_EDIT, error: parsed.error };
    return opsFromEntryEdit(info.entry, parsed.entry);
  }, [yamlText, info]);

  const provider = String(form?.fields.provider || loaded?.provider || "");
  const modelId = String(form?.fields.model || loaded?.model || "");

  function update(key: string, value: string | string[] | null) {
    setForm((f) => f && { ...f, fields: { ...f.fields, [key]: value } });
    setErrors(({ [key]: _gone, ...rest }) => rest);
    setReview(undefined);
  }
  function patchForm(p: Partial<ModelForm>) {
    setForm((f) => f && { ...f, ...p });
    setReview(undefined);
  }
  function editYaml(text: string) {
    setYamlText(text);
    setErrors((e) =>
      Object.fromEntries(
        Object.entries(e).filter(([k]) => !yamlErrorKeys.has(k)),
      ),
    );
    setYamlErrorKeys(new Set());
    setReview(undefined);
  }

  async function startReview() {
    if (!form || !initial) return;
    setNotice(undefined);
    const { ops: formOps, errors: errs } = formToOps(initial, form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setTab(tabOf(Object.keys(errs)[0]));
      return;
    }
    if (yamlEdit.error) {
      setTab("advanced");
      setNotice(`The YAML cannot be read. ${yamlEdit.error}`);
      return;
    }
    if (yamlEdit.refused.length > 0) {
      setTab("advanced");
      setNotice(
        `Not changed here: ${yamlEdit.refused.join(", ")}. Undo these in the YAML, or use Open file.`,
      );
      return;
    }
    const merged = mergeOps(formOps, yamlEdit.ops);
    if (merged.conflicts.length > 0) {
      setTab("advanced");
      setNotice(
        `Changed both on another tab and in the YAML: ${merged.conflicts.join(", ")}. Undo one of the two.`,
      );
      return;
    }
    const ops = merged.ops;
    const stores = secretsToStore(form);
    if (ops.length === 0 && stores.length === 0) {
      setNotice("Nothing has changed.");
      return;
    }
    setBusy(true);
    try {
      const res = await ideMessenger.request("config/previewModelEdit", {
        title,
        ops,
      });
      if (res.status !== "success") {
        setNotice(String(res.error ?? "Could not check the change."));
        return;
      }
      const p = res.content;
      if (p.errors.length > 0) {
        const byPath = Object.fromEntries(
          p.errors.map((e) => [e.path.join("."), e.message]),
        );
        // An error is shown where its change was typed: the YAML text when
        // only the YAML changed anything, or when it changed that setting
        const yamlKeys = new Set(yamlEdit.ops.map((o) => pathKey(o.path)));
        const onlyYaml = formOps.length === 0;
        const inYaml = new Set(
          Object.keys(byPath).filter((k) => onlyYaml || yamlKeys.has(k)),
        );
        setErrors(byPath);
        setYamlErrorKeys(inYaml);
        const first = Object.keys(byPath)[0];
        setTab(inYaml.has(first) ? "advanced" : tabOf(first));
        return;
      }
      if (p.error) {
        setNotice(p.error);
        return;
      }
      setReview({ ops, diff: p.diff, baseHash: p.baseHash ?? "", stores });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!review || !form) return;
    setBusy(true);
    setNotice(undefined);
    try {
      // Every typed credential is stored first; if one fails, nothing is saved
      for (const secret of review.stores) {
        const stored = await ideMessenger.request("config/setSecret", {
          secretName: secret.secretName,
          value: secret.value,
          storage: secret.storage,
        });
        if (stored.status !== "success" || !stored.content.stored) {
          setNotice(
            stored.status === "success"
              ? (stored.content.error ??
                  `The ${secret.label} could not be stored.`)
              : String(
                  stored.error ?? `The ${secret.label} could not be stored.`,
                ),
          );
          return;
        }
      }
      if (review.ops.length === 0) return onDone();
      const res = await ideMessenger.request("config/saveModelEdit", {
        title,
        ops: review.ops,
        baseHash: review.baseHash,
      });
      if (res.status !== "success") {
        setNotice(String(res.error ?? "Could not save."));
        return;
      }
      if (res.content.stale) {
        setReview(undefined);
        setNotice(res.content.error);
        return;
      }
      if (res.content.errors.length > 0 || res.content.error) {
        setReview(undefined);
        setNotice(
          res.content.error ??
            res.content.errors.map((e) => e.message).join(" "),
        );
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  function onTabKey(e: React.KeyboardEvent, index: number) {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  }

  const errorTabs = useMemo(() => {
    const tabs = new Set<Tab>(
      Object.keys(errors).map((k) =>
        yamlErrorKeys.has(k) ? "advanced" : tabOf(k),
      ),
    );
    if (yamlEdit.error || yamlEdit.refused.length > 0) tabs.add("advanced");
    return tabs;
  }, [errors, yamlErrorKeys, yamlEdit]);

  const header = (
    <div className="flex flex-col gap-1">
      <h2 id={titleId} className="m-0 text-base">
        Configure {title}
      </h2>
      {info?.file && (
        <span className="text-2xs break-all text-description-muted">
          {info.scope === "workspace" ? "Workspace config" : "User config"}:{" "}
          <code>{info.file}</code>{" "}
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 text-2xs text-link underline"
            onClick={onOpenFile}
          >
            Open file
          </button>
        </span>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (loadError || (info && !info.editable)) {
    body = (
      <>
        <p className="m-0 text-sm" role="alert">
          {loadError ?? info?.reason}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Close
          </Button>
          <Button onClick={onOpenFile}>Open file</Button>
        </div>
      </>
    );
  } else if (!form || !info) {
    body = <p className="m-0 text-sm">Loading...</p>;
  } else {
    const fieldProps = { form, errors, update, provider, entry: info.entry };
    body = (
      <>
        {review ? (
          <ReviewPanel diff={review.diff} stores={review.stores} />
        ) : (
          <>
            <div
              role="tablist"
              aria-label="Model settings"
              className="flex flex-wrap gap-1 border-0 border-b border-solid border-border"
            >
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  id={`${titleId}-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`${titleId}-panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={`cursor-pointer border-0 border-b-2 border-solid bg-transparent px-2 py-1 text-xs text-foreground ${
                    tab === t.id
                      ? "border-b-border-focus"
                      : "border-b-transparent"
                  }`}
                >
                  {t.label}
                  {errorTabs.has(t.id) && (
                    <span className="ml-1 text-error">
                      <span aria-hidden="true">!</span>
                      <span className="sr-only"> (has errors)</span>
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div
              role="tabpanel"
              id={`${titleId}-panel-${tab}`}
              aria-labelledby={`${titleId}-tab-${tab}`}
              className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1"
            >
              {tab === "connection" && (
                <ConnectionPanel
                  {...fieldProps}
                  info={info}
                  loaded={loaded}
                  title={title}
                  modelId={modelId}
                  setKey={(key) => {
                    patchForm({ key });
                    setErrors(({ apiKey: _gone, ...rest }) => rest);
                  }}
                  setSecret={(k, choice) => {
                    patchForm({ secrets: { ...form.secrets, [k]: choice } });
                    setErrors(({ [k]: _gone, ...rest }) => rest);
                  }}
                  setHeaders={(headers) => patchForm({ headers })}
                />
              )}
              {tab === "capabilities" && (
                <CapabilitiesPanel
                  {...fieldProps}
                  loaded={loaded}
                  modelId={modelId}
                  systemToolsForced={
                    !!config.experimental?.onlyUseSystemMessageTools
                  }
                  setTri={(p) => {
                    patchForm(p);
                    setErrors(({ capabilities: _gone, ...rest }) => rest);
                  }}
                />
              )}
              {tab === "generation" && (
                <FieldList section="generation" {...fieldProps} />
              )}
              {tab === "templates" && (
                <TemplatesPanel
                  {...fieldProps}
                  modelId={modelId}
                  tools={(config.tools ?? []) as Tool[]}
                  setOverrides={(toolOverrides) => patchForm({ toolOverrides })}
                />
              )}
              {tab === "context" && (
                <>
                  <FieldList
                    section="context"
                    {...fieldProps}
                    only={(f) => f.path[0] !== "pricing"}
                  />
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-1 text-xs font-medium">
                      Price (used by budgets)
                    </legend>
                    <PriceNote
                      provider={provider}
                      model={modelId}
                      form={form}
                    />
                    <FieldList
                      section="context"
                      {...fieldProps}
                      only={(f) => f.path[0] === "pricing"}
                    />
                  </fieldset>
                </>
              )}
              {tab === "advanced" && (
                <AdvancedPanel
                  text={yamlText ?? info.entryYaml ?? ""}
                  edit={yamlEdit}
                  errors={Object.entries(errors).filter(([k]) =>
                    yamlErrorKeys.has(k),
                  )}
                  changed={
                    yamlText !== undefined && yamlText !== info.entryYaml
                  }
                  onChange={editYaml}
                  onReset={() => editYaml(info.entryYaml ?? "")}
                />
              )}
            </div>
          </>
        )}

        {notice && (
          <p className="m-0 text-xs text-warning" role="status">
            {notice}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {review ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setReview(undefined)}
                disabled={busy}
              >
                Back
              </Button>
              <Button
                onClick={save}
                disabled={busy}
                data-testid="model-config-save"
              >
                Save
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              <Button
                onClick={startReview}
                disabled={busy}
                data-testid="model-config-review"
              >
                Review changes
              </Button>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={!loadError && !info ? true : undefined}
      tabIndex={-1}
      className="flex flex-col gap-3 p-4 outline-none"
      data-testid="model-config-dialog"
    >
      {header}
      {body}
    </div>
  );
}

interface FieldProps {
  form: ModelForm;
  errors: Record<string, string>;
  update: (key: string, value: string | string[] | null) => void;
  provider: string;
  entry?: Record<string, unknown>;
}

function FieldList({
  section,
  only,
  ...props
}: FieldProps & {
  section: ModelEditSection;
  only?: (f: ModelEditField) => boolean;
}) {
  const fields = visibleFields(section, props.provider, props.entry).filter(
    (f) =>
      pathKey(f.path) !== "roles" &&
      pathKey(f.path) !== "toolDialect" &&
      (!only || only(f)),
  );
  return (
    <>
      {fields.map((f) => (
        <FieldInput key={pathKey(f.path)} field={f} {...props} />
      ))}
    </>
  );
}

function FieldInput({
  field,
  form,
  errors,
  update,
  placeholder,
}: FieldProps & { field: ModelEditField; placeholder?: string }) {
  const key = pathKey(field.path);
  const id = `mc-${key.replace(/\./g, "-")}`;
  const value = form.fields[key];
  const error = errors[key] ?? fieldError(field, value);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const described =
    [error ? errorId : "", field.help ? helpId : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": described,
  } as const;

  let control: React.ReactNode;
  if (field.kind === "boolean") {
    control = (
      <FormSelect
        {...common}
        className="text-xs"
        value={(value as BoolChoice) ?? "default"}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="default">
          Default{field.defaultText ? ` (${field.defaultText})` : ""}
        </option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </FormSelect>
    );
  } else if (field.kind === "enum") {
    control = (
      <FormSelect
        {...common}
        className="text-xs"
        value={(value as string) ?? ""}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="">
          Default{field.defaultText ? ` (${field.defaultText})` : ""}
        </option>
        {field.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </FormSelect>
    );
  } else if (field.kind === "list" || field.kind === "multiline") {
    const multiline = field.kind === "multiline";
    control = (
      <textarea
        {...common}
        rows={multiline ? 4 : 2}
        spellCheck={multiline ? undefined : false}
        className={`${inputClass} ${multiline ? "font-mono" : ""}`}
        value={(value as string) ?? ""}
        placeholder={
          placeholder ??
          (field.defaultText ? `Default: ${field.defaultText}` : undefined)
        }
        onChange={(e) => update(key, e.target.value)}
      />
    );
  } else {
    control = (
      <input
        {...common}
        type="text"
        inputMode={field.kind === "number" ? "decimal" : undefined}
        className={inputClass}
        value={(value as string) ?? ""}
        placeholder={
          placeholder ??
          (field.defaultText ? `Default: ${field.defaultText}` : undefined)
        }
        onChange={(e) => update(key, e.target.value)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {field.label}
      </label>
      {control}
      {field.help && (
        <span id={helpId} className="text-2xs text-description-muted">
          {field.help}
        </span>
      )}
      {error && (
        <span id={errorId} className="text-2xs text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function ConnectionPanel(
  props: FieldProps & {
    info: ModelBlockInfo;
    loaded?: ModelDescription;
    title: string;
    modelId: string;
    setKey: (k: KeyChoice) => void;
    setSecret: (key: string, k: KeyChoice) => void;
    setHeaders: (h: HeaderRow[]) => void;
  },
) {
  const { form, info, loaded, provider, modelId, title } = props;
  const connection = info.entry?.connection;
  const apiBase = String(form.fields.apiBase || "") || undefined;
  const typedKey =
    form.key.mode === "secret" && form.key.value ? form.key.value : undefined;
  // The key the loaded model already uses; an unresolved reference is no key.
  const loadedKey =
    loaded?.apiKey && !loaded.apiKey.includes("${{")
      ? loaded.apiKey
      : undefined;
  const isBedrock = provider === "bedrock" || provider === "bedrock-mantle";
  const secretFields = SECRET_FIELDS.filter(
    (f) =>
      !f.providers ||
      f.providers.includes(provider) ||
      getPath(info.entry, f.path) !== undefined,
  );

  return (
    <>
      {typeof connection === "string" && (
        <p className="m-0 text-xs text-description-muted">
          Connection settings come from the provider account{" "}
          <code>{connection}</code>. A value set here applies to this model only
          and wins over the account's.
        </p>
      )}
      <FieldList section="connection" {...props} />
      <KeyEditor
        label="API key"
        noun="key"
        state={info.credentials?.apiKey ?? { state: "none" }}
        defaultName={defaultSecretName(provider)}
        choice={form.key}
        error={props.errors.apiKey}
        onChange={props.setKey}
      />
      {secretFields.map((f) => {
        const k = pathKey(f.path);
        const name = f.path[f.path.length - 1];
        return (
          <KeyEditor
            key={k}
            label={f.label}
            noun="value"
            help={f.help}
            state={info.credentials?.env[name] ?? { state: "none" }}
            defaultName={`${upperSnake(provider || "aws").replace(/-/g, "_")}_${upperSnake(name)}`}
            choice={form.secrets[k] ?? { mode: "keep" }}
            error={props.errors[k]}
            onChange={(c) => props.setSecret(k, c)}
          />
        );
      })}
      <HeadersEditor
        rows={form.headers}
        errors={props.errors}
        onChange={props.setHeaders}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium">Test connection</span>
        {isBedrock ? (
          <BedrockConnectionTester
            connection={
              Object.fromEntries(
                Object.entries({
                  region: form.fields["env.region"],
                  profile: form.fields["env.profile"],
                  apiBase,
                  ...(provider === "bedrock-mantle"
                    ? { endpoint: "mantle" }
                    : {}),
                }).filter(([, v]) => typeof v === "string" && v !== ""),
              ) as Record<string, string>
            }
            model={modelId}
            canTest={!!modelId}
            onModelsLoaded={() => {}}
          />
        ) : hasConnectionTest(provider) ? (
          <OpenAICompatConnectionTester
            provider={provider}
            apiBase={apiBase}
            apiKey={typedKey ?? loadedKey}
            model={modelId}
            modelTitle={title}
            canTest={!!provider}
          />
        ) : (
          <span className="text-2xs text-description-muted">
            Not available for {provider || "this provider"} yet. Uses the values
            above before they are saved.
          </span>
        )}
      </div>
    </>
  );
}

function KeyEditor({
  label,
  noun,
  help,
  state,
  defaultName,
  choice,
  error,
  onChange,
}: {
  label: string;
  /** What the secret holds, in the texts: "key" for an API key, else "value". */
  noun: "key" | "value";
  help?: string;
  state: NonNullable<ModelBlockInfo["credentials"]>["apiKey"];
  defaultName: string;
  choice: KeyChoice;
  error?: string;
  onChange: (k: KeyChoice) => void;
}) {
  const groupId = useId();
  const current =
    state.state === "secret"
      ? `Stored as the secret ${state.secretName}.`
      : state.state === "plaintext"
        ? "Written in plain text in config.yaml (hidden here). Move it to a secret so it is not in the file."
        : state.state === "template"
          ? `Read from ${state.text}.`
          : noun === "key"
            ? "No key is set."
            : "Not set.";
  const secretChoice = (): KeyChoice => ({
    mode: "secret",
    secretName: state.state === "secret" ? state.secretName : defaultName,
    value: "",
    storage: "secure",
  });
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-xs font-medium">{label}</legend>
      <span
        className={`text-2xs ${state.state === "plaintext" ? "text-warning" : "text-description-muted"}`}
      >
        {current}
        {help ? ` ${help}` : ""}
      </span>
      <div
        className="flex flex-wrap gap-3 text-xs"
        role="radiogroup"
        aria-label={label}
      >
        {(
          [
            ["keep", "Keep as it is"],
            ["secret", "Use a secret"],
            ["remove", "Remove"],
          ] as const
        ).map(([mode, text]) => (
          <label key={mode} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${groupId}-key`}
              checked={choice.mode === mode}
              onChange={() =>
                onChange(mode === "secret" ? secretChoice() : { mode })
              }
            />
            {text}
          </label>
        ))}
      </div>
      {choice.mode === "secret" && (
        <div className="flex flex-col gap-2 pl-4">
          <label className="flex flex-col gap-1 text-xs">
            Secret name
            <input
              className={inputClass}
              value={choice.secretName}
              aria-invalid={error ? true : undefined}
              onChange={(e) =>
                onChange({ ...choice, secretName: e.target.value })
              }
            />
          </label>
          <span className="text-2xs text-description-muted">
            config.yaml gets{" "}
            <code>{`\${{ secrets.${choice.secretName || "NAME"} }}`}</code>,
            never the {noun}.
          </span>
          <label className="flex flex-col gap-1 text-xs">
            New {noun === "key" ? "key value" : "value"} (leave empty if this
            secret is already set)
            <input
              type="password"
              autoComplete="off"
              className={inputClass}
              value={choice.value}
              onChange={(e) => onChange({ ...choice, value: e.target.value })}
            />
          </label>
          {choice.value && (
            <label className="flex flex-col gap-1 text-xs">
              Keep the {noun} in
              <FormSelect
                className="text-xs"
                value={choice.storage}
                onChange={(e) =>
                  onChange({
                    ...choice,
                    storage: e.target.value as "secure" | "env",
                  })
                }
              >
                <option value="secure">Secure storage (this machine)</option>
                <option value="env">~/.continuous/.env (plain text)</option>
              </FormSelect>
            </label>
          )}
        </div>
      )}
      {error && (
        <span className="text-2xs text-error" role="alert">
          {error}
        </span>
      )}
    </fieldset>
  );
}

function HeadersEditor({
  rows,
  errors,
  onChange,
}: {
  rows: HeaderRow[];
  errors: Record<string, string>;
  onChange: (rows: HeaderRow[]) => void;
}) {
  const set = (id: string, p: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="mb-1 text-xs font-medium">Request headers</legend>
      {rows.length === 0 && (
        <span className="text-2xs text-description-muted">None.</span>
      )}
      {rows.map((r) => {
        const sensitive = !!r.withheld || headerIsSensitive(r.name);
        const error =
          errors[`requestOptions.headers.${r.name.trim()}`] ??
          errors[`requestOptions.headers.${r.id}`];
        return (
          <div key={r.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <input
                aria-label="Header name"
                className={`${inputClass} w-2/5`}
                value={r.name}
                disabled={!!r.withheld}
                onChange={(e) => set(r.id, { name: e.target.value })}
              />
              <input
                aria-label={`Value of ${r.name || "header"}`}
                aria-invalid={error ? true : undefined}
                className={inputClass}
                value={r.value}
                placeholder={
                  r.withheld
                    ? r.withheld.state === "secret"
                      ? `\${{ secrets.${r.withheld.secretName} }} (kept)`
                      : "hidden (kept unless you type a secret reference)"
                    : sensitive
                      ? "${{ secrets.NAME }}"
                      : undefined
                }
                onChange={(e) => set(r.id, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove header ${r.name}`}
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                Remove
              </Button>
            </div>
            {error && (
              <span className="text-2xs text-error" role="alert">
                {error}
              </span>
            )}
          </div>
        );
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...rows,
              { id: `new${Date.now()}${rows.length}`, name: "", value: "" },
            ])
          }
        >
          Add header
        </Button>
      </div>
    </fieldset>
  );
}

const TRI_LABEL: Record<TriState, string> = {
  auto: "Auto-detect",
  on: "Yes",
  off: "No",
};

function CapabilitiesPanel(
  props: FieldProps & {
    loaded?: ModelDescription;
    modelId: string;
    systemToolsForced: boolean;
    setTri: (p: Partial<Pick<ModelForm, "tools" | "images">>) => void;
  },
) {
  const { form, errors, update, loaded, modelId, provider } = props;
  const groupId = useId();
  const roles = form.fields.roles as string[] | null;
  const dialect = (form.fields.toolDialect as string) || "auto";
  const info = DIALECT_INFO[dialect as ToolDialectSetting];
  const detectedNative = loaded
    ? modelSupportsNativeTools({
        ...loaded,
        capabilities: { ...loaded.capabilities, tools: undefined },
      })
    : undefined;
  const effectiveNative = props.systemToolsForced
    ? false
    : form.tools === "auto"
      ? (detectedNative ?? true)
      : form.tools === "on";
  const hint = presetHint(modelId);
  const rolesError = errors.roles;

  return (
    <>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs font-medium">Roles</legend>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={roles === null}
            onChange={(e) =>
              update("roles", e.target.checked ? null : [...DEFAULT_ROLES])
            }
          />
          Default ({DEFAULT_ROLES.join(", ")})
        </label>
        {roles !== null && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pl-4 text-xs">
            {MODEL_ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) =>
                    update(
                      "roles",
                      e.target.checked
                        ? [...roles, r]
                        : roles.filter((x) => x !== r),
                    )
                  }
                />
                {r}
              </label>
            ))}
          </div>
        )}
        {(rolesError || (roles && roles.length === 0)) && (
          <span className="text-2xs text-error" role="alert">
            {rolesError ??
              "Pick at least one role, or go back to the default roles."}
          </span>
        )}
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs font-medium">
          How tools are sent (prompt style)
        </legend>
        <div
          className="flex flex-wrap gap-3 text-xs"
          role="radiogroup"
          aria-label="How tools are sent"
        >
          {(
            [
              ["auto", "Auto-detect"],
              ["on", "Native tool calls"],
              ["off", "Described in the system message"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-1">
              <input
                type="radio"
                name={`${groupId}-tools`}
                checked={form.tools === v}
                onChange={() => props.setTri({ tools: v })}
              />
              {label}
              {v === "auto" && detectedNative !== undefined && (
                <span className="text-description-muted">
                  ({detectedNative ? "native" : "system message"})
                </span>
              )}
            </label>
          ))}
        </div>
        {props.systemToolsForced && (
          <span className="text-2xs text-warning">
            "Only use system message tools" is on in settings, so every model
            gets its tools in the system message.
          </span>
        )}
        {hint && (
          <span
            className="text-2xs text-description-muted"
            data-testid="preset-hint"
          >
            Known family {hint.label}: asks for {hint.style}. {hint.evidence}
          </span>
        )}
        <Preview
          label={
            effectiveNative
              ? `Sent as an API tool definition (${SAMPLE_TOOL_NAME} shown):`
              : `Added to the system message (${SAMPLE_TOOL_NAME} shown):`
          }
          text={toolPromptPreview(effectiveNative ? "native" : "systemMessage")}
          testId="tool-prompt-preview"
        />
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-xs font-medium">Image input</legend>
        <div
          className="flex flex-wrap gap-3 text-xs"
          role="radiogroup"
          aria-label="Image input"
        >
          {(["auto", "on", "off"] as const).map((v) => (
            <label key={v} className="flex items-center gap-1">
              <input
                type="radio"
                name={`${groupId}-images`}
                checked={form.images === v}
                onChange={() => props.setTri({ images: v })}
              />
              {TRI_LABEL[v]}
            </label>
          ))}
        </div>
      </fieldset>
      {errors.capabilities && (
        <span className="text-2xs text-error" role="alert">
          {errors.capabilities}
        </span>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="mc-toolDialect" className="text-xs font-medium">
          Tool calls written as text (tool dialect)
        </label>
        <FormSelect
          id="mc-toolDialect"
          className="text-xs"
          value={(form.fields.toolDialect as string) ?? ""}
          aria-describedby="mc-toolDialect-summary"
          onChange={(e) => update("toolDialect", e.target.value)}
        >
          <option value="">{DIALECT_INFO.auto.label}</option>
          {Object.entries(DIALECT_INFO)
            .filter(([v]) => v !== "auto")
            .map(([v, d]) => (
              <option key={v} value={v}>
                {d.label} ({v})
              </option>
            ))}
        </FormSelect>
        <span
          id="mc-toolDialect-summary"
          className="text-2xs text-description-muted"
        >
          {info?.summary}
          {hint?.recoverWith && hint.recoverWith !== dialect
            ? ` This family's text calls are read with ${hint.recoverWith}.`
            : ""}
        </span>
        {provider && !providerRecoversText(provider) && dialect !== "auto" && (
          <span className="text-2xs text-warning">
            {provider} requests are not read for text calls in the IDE, so this
            setting has no effect there.
          </span>
        )}
        {info?.sample && (
          <Preview
            label={`A reply in this form runs ${SAMPLE_TOOL_NAME}:`}
            text={info.sample}
            testId="tool-dialect-preview"
          />
        )}
        {errors.toolDialect && (
          <span className="text-2xs text-error" role="alert">
            {errors.toolDialect}
          </span>
        )}
      </div>
    </>
  );
}

const SYSTEM_MESSAGE_KEYS = [
  ["chatOptions.baseSystemMessage", "Chat"],
  ["chatOptions.baseAgentSystemMessage", "Agent"],
  ["chatOptions.basePlanSystemMessage", "Plan"],
] as const;

const PROMPT_TEMPLATE_KINDS: PromptTemplateKind[] = [
  "edit",
  "apply",
  "autocomplete",
];

function TemplatesPanel(
  props: FieldProps & {
    modelId: string;
    tools: Tool[];
    setOverrides: (rows: ToolOverrideRow[]) => void;
  },
) {
  const { form, provider, modelId } = props;
  const [mode, setMode] = useState<(typeof SYSTEM_MESSAGE_KEYS)[number][0]>(
    "chatOptions.baseSystemMessage",
  );
  const fieldOf = (key: string) =>
    MODEL_EDIT_FIELDS.find((f) => pathKey(f.path) === key)!;
  const typed = (key: string) => {
    const v = form.fields[key];
    return typeof v === "string" && v.trim() ? v : undefined;
  };
  const chatTemplate = typed("promptTemplates.chat");
  const rendered = chatTemplatePreview(modelId, provider, chatTemplate);
  const previewId = useId();

  return (
    <>
      <p className="m-0 text-2xs text-description-muted">
        What this model is told before your message. An empty field uses the
        built-in text, shown greyed. Rules and tool instructions are added after
        the system message.
      </p>
      {SYSTEM_MESSAGE_KEYS.map(([key]) => (
        <FieldInput
          key={key}
          field={fieldOf(key)}
          {...props}
          placeholder={DEFAULT_SYSTEM_MESSAGES[key]}
        />
      ))}
      <div className="flex flex-col gap-1">
        <label htmlFor={previewId} className="text-2xs text-description-muted">
          Preview the system message for
        </label>
        <FormSelect
          id={previewId}
          className="text-xs"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          {SYSTEM_MESSAGE_KEYS.map(([key, label]) => (
            <option key={key} value={key}>
              {label} mode
            </option>
          ))}
        </FormSelect>
        <Preview
          label={
            typed(mode)
              ? "Sent first, as you wrote it:"
              : "Sent first (the built-in text):"
          }
          text={typed(mode) ?? DEFAULT_SYSTEM_MESSAGES[mode]}
          testId="system-message-preview"
        />
      </div>

      <FieldInput field={fieldOf("promptTemplates.chat")} {...props} />
      {rendered.text !== undefined ? (
        <Preview
          label="A short conversation as this template sends it:"
          text={rendered.text}
          testId="chat-template-preview"
        />
      ) : (
        <span
          className="text-2xs text-description-muted"
          data-testid="chat-template-preview"
        >
          {provider || "This provider"} sends chat messages and the server
          applies the model's own template, so nothing is templated here.
        </span>
      )}

      {PROMPT_TEMPLATE_KINDS.map((kind) => {
        const key = `promptTemplates.${kind}`;
        const value = typed(key);
        const result = value ? renderTemplatePreview(kind, value) : undefined;
        return (
          <div key={kind} className="flex flex-col gap-1">
            <FieldInput field={fieldOf(key)} {...props} />
            <span className="text-2xs text-description-muted">
              Handlebars. Filled in:{" "}
              {Object.keys(TEMPLATE_VARIABLES[kind])
                .map((v) => `{{{${v}}}}`)
                .join(", ")}
              .
            </span>
            {result?.error && (
              <span className="text-2xs text-warning">
                This template does not compile: {result.error}
              </span>
            )}
            {result && result.unknown.length > 0 && (
              <span className="text-2xs text-warning">
                Never filled in, so empty: {result.unknown.join(", ")}.
              </span>
            )}
            {result?.text !== undefined && (
              <Preview
                label="With sample values:"
                text={result.text}
                testId={`${kind}-template-preview`}
              />
            )}
          </div>
        );
      })}

      <ToolOverridesEditor
        rows={form.toolOverrides}
        tools={props.tools}
        errors={props.errors}
        onChange={props.setOverrides}
      />
    </>
  );
}

function ToolOverridesEditor({
  rows,
  tools,
  errors,
  onChange,
}: {
  rows: ToolOverrideRow[];
  tools: Tool[];
  errors: Record<string, string>;
  onChange: (rows: ToolOverrideRow[]) => void;
}) {
  const set = (id: string, p: Partial<ToolOverrideRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const names = [
    ...new Set([
      ...tools.map((t) => t.function.name),
      ...rows.map((r) => r.tool).filter(Boolean),
    ]),
  ].sort();
  const byName = new Map(tools.map((t) => [t.function.name, t]));
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-xs font-medium">Tool overrides</legend>
      <span className="text-2xs text-description-muted">
        Describe a tool differently to this model, or turn it off for this model
        only. Other override settings written in the file are kept.
      </span>
      {rows.map((r, i) => {
        const tool = byName.get(r.tool);
        const error =
          errors[`chatOptions.toolOverrides.${r.tool.trim()}`] ??
          errors[`chatOptions.toolOverrides.${r.id}`];
        const value = overrideValue(r);
        const effective =
          tool &&
          applyToolOverrides(
            [tool],
            value ? [{ ...value, name: r.tool } as ToolOverride] : [],
          ).tools[0];
        const n = i + 1;
        return (
          <div
            key={r.id}
            className="flex flex-col gap-1 border-0 border-l-2 border-solid border-border pl-2"
          >
            <label className="flex flex-col gap-1 text-xs">
              Tool (override {n})
              <FormSelect
                className="text-xs"
                value={r.tool}
                aria-invalid={error ? true : undefined}
                onChange={(e) => set(r.id, { tool: e.target.value })}
              >
                <option value="">Choose a tool</option>
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </FormSelect>
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={r.disabled}
                onChange={(e) => set(r.id, { disabled: e.target.checked })}
              />
              Turn this tool off for this model
            </label>
            {!r.disabled && (
              <label className="flex flex-col gap-1 text-xs">
                Description sent to the model
                <textarea
                  rows={2}
                  className={inputClass}
                  value={r.description}
                  placeholder={tool?.function.description ?? ""}
                  onChange={(e) => set(r.id, { description: e.target.value })}
                />
              </label>
            )}
            {r.tool && (
              <Preview
                label="What the model gets:"
                text={
                  r.disabled
                    ? `${r.tool} is not offered to this model.`
                    : effective
                      ? `${effective.function.name}: ${effective.function.description ?? ""}`
                      : `${r.tool}: ${r.description || "(not a tool this config loads)"}`
                }
                testId="tool-override-preview"
              />
            )}
            <div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove override ${n}${r.tool ? ` (${r.tool})` : ""}`}
                onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
              >
                Remove
              </Button>
            </div>
            {error && (
              <span className="text-2xs text-error" role="alert">
                {error}
              </span>
            )}
          </div>
        );
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...rows,
              {
                id: `new${Date.now()}${rows.length}`,
                tool: "",
                description: "",
                disabled: false,
              },
            ])
          }
        >
          Add tool override
        </Button>
      </div>
    </fieldset>
  );
}

function AdvancedPanel({
  text,
  edit,
  errors,
  changed,
  onChange,
  onReset,
}: {
  text: string;
  edit: YamlEdit;
  errors: [string, string][];
  changed: boolean;
  onChange: (text: string) => void;
  onReset: () => void;
}) {
  const id = useId();
  const problem = !!edit.error || edit.refused.length > 0 || errors.length > 0;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        This model's entry as YAML
      </label>
      <textarea
        id={id}
        rows={16}
        spellCheck={false}
        className={`${inputClass} font-mono`}
        value={text}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-help${problem ? ` ${id}-problems` : ""}`}
        onChange={(e) => onChange(e.target.value)}
        data-testid="model-config-yaml"
      />
      <span id={`${id}-help`} className="text-2xs text-description-muted">
        Credentials show as ••••••: leave them as they are to keep them.
        Reviewed and saved like the other tabs: the settings the other tabs
        manage can change here, the file keeps its own comments and layout, and
        a comment typed here is not written. For anything else, use Open file.
      </span>
      {problem && (
        <div id={`${id}-problems`} role="alert" className="flex flex-col gap-1">
          {edit.error && (
            <span className="text-2xs text-error">
              Cannot read this YAML. {edit.error}
            </span>
          )}
          {edit.refused.length > 0 && (
            <span className="text-2xs text-error">
              Not changed here: {edit.refused.join(", ")}. Undo these, or use
              Open file.
            </span>
          )}
          {errors.map(([k, message]) => (
            <span key={k} className="text-2xs text-error">
              {k}: {message}
            </span>
          ))}
        </div>
      )}
      {changed && !edit.error && (
        <span className="text-2xs text-description-muted" role="status">
          {edit.ops.length === 1
            ? "1 setting changed here."
            : `${edit.ops.length} settings changed here.`}
        </span>
      )}
      {changed && (
        <div>
          <Button variant="outline" size="sm" onClick={onReset}>
            Undo YAML edits
          </Button>
        </div>
      )}
    </div>
  );
}

function Preview({
  label,
  text,
  testId,
}: {
  label: string;
  text: string;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={id} className="text-2xs text-description-muted">
        {label}
      </span>
      <pre
        aria-labelledby={id}
        tabIndex={0}
        data-testid={testId}
        className="m-0 max-h-40 overflow-auto rounded-default bg-editor p-2 text-2xs whitespace-pre-wrap"
      >
        {text}
      </pre>
    </div>
  );
}

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/** A price field's input as a number, or undefined when empty or not a number. */
function rateOf(input: string | string[] | null | undefined) {
  if (typeof input !== "string" || input.trim() === "") return undefined;
  const n = Number(input.trim());
  return Number.isFinite(n) ? n : undefined;
}

function PriceNote({
  provider,
  model,
  form,
}: {
  provider: string;
  model: string;
  form: ModelForm;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const own = userPriceOf({
    pricing: {
      input: rateOf(form.fields["pricing.input"]),
      output: rateOf(form.fields["pricing.output"]),
      cacheRead: rateOf(form.fields["pricing.cacheRead"]),
      cacheWrite: rateOf(form.fields["pricing.cacheWrite"]),
    },
  });
  const per = (input: number, output: number) =>
    costOf(
      { input, output, cacheRead: 0, cacheWrite: 0 },
      { provider, model },
      { userPrice: own },
    );
  const inPrice = per(1_000_000, 0);
  const outPrice = per(0, 1_000_000);
  const known = inPrice.amount !== "unknown" && outPrice.amount !== "unknown";
  return (
    <div className="flex flex-col gap-1" data-testid="price-note">
      {known ? (
        <span className="text-2xs">
          ${usd(inPrice.amount as number)} in / $
          {usd(outPrice.amount as number)} out per million tokens
          {own
            ? `, from ${USER_PRICE_SOURCE}. Budgets and cost use it ahead of any price table`
            : inPrice.priceSource
              ? `. ${formatPriceSource(inPrice.priceSource)}`
              : inPrice.estimate
                ? `, from ${inPrice.estimate.source} as of ${inPrice.estimate.fetchedAt.slice(0, 10)}`
                : ", from the built-in price table"}
          .
          {own &&
            ` Cache reads $${usd(own.cacheRead ?? own.input)}, cache writes $${usd(own.cacheWrite ?? own.input)}.`}
          {!own && inPrice.priceSource?.kind === "community" && (
            <>
              {" "}
              A dollar budget (<code>--max-budget-usd</code>) is held on this
              estimate only with <code>--budget-allow-unpriced</code>.
            </>
          )}
        </span>
      ) : (
        <span className="text-2xs text-description-muted">
          No price is known for {provider || "?"}/{model || "?"}, so a dollar
          budget (<code>--max-budget-usd</code>) refuses to run on it and cost
          shows as unknown. Enter its input and output price below (zero for a
          model on your own hardware) to use budgets with it.
          {provider === "openrouter" && (
            <>
              {" "}
              <button
                type="button"
                className="cursor-pointer border-none bg-transparent p-0 text-2xs text-link underline"
                onClick={() =>
                  ideMessenger.post("openUrl", "https://openrouter.ai/models")
                }
              >
                See OpenRouter's prices
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

function ReviewPanel({
  diff,
  stores,
}: {
  diff: DiffLine[];
  stores: SecretToStore[];
}) {
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="model-config-review-panel"
    >
      <h3 className="m-0 text-sm">Review the change to config.yaml</h3>
      {stores.map((s) => (
        <p key={s.label} className="m-0 text-xs">
          The {s.label === "API key" ? "key" : s.label} is stored as{" "}
          <code>{s.secretName}</code> in{" "}
          {s.storage === "secure" ? "secure storage" : "~/.continuous/.env"},
          not in config.yaml.
        </p>
      ))}
      {diff.length === 0 ? (
        <p className="m-0 text-xs text-description-muted">
          config.yaml does not change.
        </p>
      ) : (
        <pre
          tabIndex={0}
          aria-label="Changes to config.yaml"
          className="m-0 max-h-[50vh] overflow-auto rounded-default bg-editor p-2 text-2xs"
          data-testid="model-config-diff"
        >
          {diff.map((l, i) => (
            <div
              key={i}
              className={
                l.kind === "add"
                  ? "text-success"
                  : l.kind === "del"
                    ? "text-error"
                    : "text-description-muted"
              }
            >
              <span aria-hidden="true">
                {l.kind === "add"
                  ? "+ "
                  : l.kind === "del"
                    ? "- "
                    : l.kind === "gap"
                      ? "  ..."
                      : "  "}
              </span>
              {l.kind === "add" && <span className="sr-only">added: </span>}
              {l.kind === "del" && <span className="sr-only">removed: </span>}
              {l.text}
            </div>
          ))}
        </pre>
      )}
      <p className="m-0 text-2xs text-description-muted">
        Comments and every setting not shown here are kept.
      </p>
    </div>
  );
}
