import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import type { LocalOnboardingChoice } from "core";
import {
  LOCAL_ONBOARDING_EMBEDDINGS_MODEL,
  LOCAL_ONBOARDING_FIM_MODEL,
  validateLocalApiBase,
  validateLocalModelName,
} from "core/config/onboarding";
import { LOCAL_SERVER_PRESETS } from "core/llm/localServers";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { Button, Input, SecondaryButton } from "../..";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { providers } from "../../../pages/AddNewModel/configs/providers";
import { announce } from "../../a11y/announcer";

const presetBase = (title: string) =>
  LOCAL_SERVER_PRESETS.find((p) => p.title.startsWith(title))?.apiBase ?? "";

/**
 * The providers of the Local tab, from the provider definitions of the Add
 * model page. `apiBase` is what the address field starts with; Ollama has
 * none, as its own default is used.
 */
export const LOCAL_PROVIDER_CHOICES: {
  id: string;
  provider: string;
  title: string;
  apiBase?: string;
}[] = [
  { id: "ollama", provider: "ollama", title: providers.ollama!.title },
  {
    id: "lmstudio",
    provider: "lmstudio",
    title: providers.lmstudio!.title,
    apiBase: providers.lmstudio!.params?.apiBase ?? presetBase("LM Studio"),
  },
  {
    id: "llama.cpp",
    provider: "llama.cpp",
    title: providers["llama.cpp"]!.title,
    apiBase: "http://127.0.0.1:8080/",
  },
  {
    id: "vllm",
    provider: "vllm",
    title: "vLLM",
    apiBase: presetBase("vLLM"),
  },
  {
    id: "openai",
    provider: "openai",
    // "Local server (OpenAI-compatible)" is cut off in a 300 px select
    title: "OpenAI-compatible server",
    apiBase: "",
  },
];

export const OTHER_PROVIDER_LINK = "Choose another provider (cloud or API key)";

interface LocalModelChooserProps {
  /** The choice in force, to start from. */
  initial?: LocalOnboardingChoice;
  /** Models Ollama reports as installed; empty when it is not running. */
  installedModels: string[];
  onSave: (choice: LocalOnboardingChoice) => void;
  onCancel: () => void;
  onChooseOtherProvider: () => void;
}

type ErrorKey = "chatModel" | "apiBase" | "fimModel" | "embeddingsModel";
type Errors = Partial<Record<ErrorKey, string>>;

const selectClass =
  "w-full rounded-default border border-solid border-description bg-input px-2 py-1.5 text-sm text-foreground";
const labelClass = "mb-1 block text-sm font-medium text-foreground";

/**
 * The form behind "Configure model" on the Local tab: which local server,
 * which chat model, and optionally the autocomplete and embeddings models.
 * It asks nothing of the network; the installed models come from the list
 * the tab already reads from the local Ollama.
 */
export function LocalModelChooser({
  initial,
  installedModels,
  onSave,
  onCancel,
  onChooseOtherProvider,
}: LocalModelChooserProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const uid = useId();
  const first = useRef<HTMLSelectElement>(null);

  const [providerId, setProviderId] = useState(
    LOCAL_PROVIDER_CHOICES.find(
      (p) => p.provider === (initial?.provider ?? "ollama"),
    )?.id ?? "ollama",
  );
  const choice = LOCAL_PROVIDER_CHOICES.find((p) => p.id === providerId)!;
  const isOllama = choice.provider === "ollama";

  const [apiBase, setApiBase] = useState(
    initial?.apiBase ?? choice.apiBase ?? "",
  );
  const [chatModel, setChatModel] = useState(initial?.chatModel ?? "");
  const [fimModel, setFimModel] = useState(initial?.fimModel ?? "");
  const [embeddingsModel, setEmbeddingsModel] = useState(
    initial?.embeddingsModel ?? "",
  );
  const [showMore, setShowMore] = useState(
    !!initial?.fimModel || !!initial?.embeddingsModel,
  );
  const [errors, setErrors] = useState<Errors>({});

  useEffect(() => {
    first.current?.focus();
  }, []);

  function changeProvider(id: string) {
    const next = LOCAL_PROVIDER_CHOICES.find((p) => p.id === id)!;
    setProviderId(id);
    setApiBase(next.apiBase ?? "");
    setErrors({});
  }

  const trimmedChat = chatModel.trim();
  const pullCommand = `ollama pull ${trimmedChat || "<model>"}`;
  const needsPull =
    isOllama && !!trimmedChat && !installedModels.includes(trimmedChat);

  function save() {
    const next: Errors = {};
    const chatError = validateLocalModelName(chatModel);
    if (chatError) next.chatModel = chatError;
    if (!isOllama) {
      const baseError = validateLocalApiBase(apiBase);
      if (baseError) next.apiBase = baseError;
    }
    for (const [key, value] of [
      ["fimModel", fimModel],
      ["embeddingsModel", embeddingsModel],
    ] as const) {
      if (value.trim()) {
        const error = validateLocalModelName(value);
        if (error) next[key] = error;
      }
    }
    setErrors(next);
    const messages = Object.values(next);
    if (messages.length > 0) {
      if (next.fimModel || next.embeddingsModel) setShowMore(true);
      announce(messages.join(" "), "assertive");
      return;
    }
    onSave({
      provider: choice.provider,
      chatModel: trimmedChat,
      ...(isOllama ? {} : { apiBase: apiBase.trim() }),
      ...(fimModel.trim() ? { fimModel: fimModel.trim() } : {}),
      ...(embeddingsModel.trim()
        ? { embeddingsModel: embeddingsModel.trim() }
        : {}),
    });
  }

  function copyPull() {
    ideMessenger.post("copyText", { text: pullCommand });
  }

  const field = (
    key: ErrorKey,
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
    hint?: string,
  ) => (
    <div>
      <label className={labelClass} htmlFor={`${uid}-${key}`}>
        {label}
      </label>
      <Input
        id={`${uid}-${key}`}
        data-testid={`local-chooser-${key}`}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={
          [errors[key] && `${uid}-${key}-error`, hint && `${uid}-${key}-hint`]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(e) => {
          set(e.target.value);
          if (errors[key]) setErrors({ ...errors, [key]: undefined });
        }}
      />
      {hint && (
        <span
          id={`${uid}-${key}-hint`}
          className="block text-xs text-description-muted"
        >
          {hint}
        </span>
      )}
      {errors[key] && (
        <span
          id={`${uid}-${key}-error`}
          className="block text-xs text-error"
          data-testid={`local-chooser-${key}-error`}
        >
          {errors[key]}
        </span>
      )}
    </div>
  );

  return (
    <form
      className="mt-3 flex flex-col gap-3 px-2"
      data-testid="local-model-chooser"
      aria-label="Choose a local model"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div>
        <label className={labelClass} htmlFor={`${uid}-provider`}>
          Provider
        </label>
        <select
          id={`${uid}-provider`}
          ref={first}
          className={selectClass}
          value={providerId}
          onChange={(e) => changeProvider(e.target.value)}
        >
          {LOCAL_PROVIDER_CHOICES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === "ollama" ? `${p.title} (default)` : p.title}
            </option>
          ))}
        </select>
      </div>

      {!isOllama &&
        field(
          "apiBase",
          "Server address",
          apiBase,
          setApiBase,
          "e.g. http://127.0.0.1:8080/v1/",
        )}

      {isOllama && installedModels.length > 0 && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-installed`}>
            Installed model
          </label>
          <select
            id={`${uid}-installed`}
            data-testid="local-chooser-installed"
            className={selectClass}
            value={installedModels.includes(chatModel) ? chatModel : ""}
            onChange={(e) => {
              if (e.target.value) {
                setChatModel(e.target.value);
                setErrors({ ...errors, chatModel: undefined });
              }
            }}
          >
            <option value="">Choose an installed model</option>
            {installedModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {field(
        "chatModel",
        isOllama && installedModels.length > 0
          ? "Or any other model"
          : "Chat model",
        chatModel,
        setChatModel,
        isOllama ? "e.g. qwen3:8b" : "the model name the server uses",
        isOllama && installedModels.length === 0
          ? "No installed models found: Ollama is not running, or has none."
          : undefined,
      )}

      {needsPull && (
        <div data-testid="local-chooser-pull">
          <p className="m-0 mb-1 text-xs text-description-muted">
            Not installed yet. Run this in a terminal:
          </p>
          <button
            type="button"
            onClick={copyPull}
            aria-label={`Copy ${pullCommand}`}
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-default border border-solid border-description bg-input px-2 py-1 text-left text-foreground hover:brightness-125"
          >
            <span className="font-mono text-xs break-all">{pullCommand}</span>
            <ClipboardDocumentIcon
              width={16}
              height={16}
              className="shrink-0"
              aria-hidden="true"
            />
          </button>
        </div>
      )}

      <div>
        <button
          type="button"
          aria-expanded={showMore}
          aria-controls={`${uid}-more`}
          onClick={() => setShowMore(!showMore)}
          className="cursor-pointer border-none bg-transparent p-0 text-sm text-foreground underline"
        >
          More
        </button>
        {showMore && (
          <div id={`${uid}-more`} className="mt-2 flex flex-col gap-3">
            {field(
              "fimModel",
              "Autocomplete model (optional)",
              fimModel,
              setFimModel,
              isOllama ? LOCAL_ONBOARDING_FIM_MODEL : "none",
              isOllama
                ? "Left empty, the suggested one is used."
                : "Left empty, no autocomplete model is set.",
            )}
            {field(
              "embeddingsModel",
              "Embeddings model (optional)",
              embeddingsModel,
              setEmbeddingsModel,
              isOllama ? LOCAL_ONBOARDING_EMBEDDINGS_MODEL : "none",
              isOllama
                ? "Left empty, the suggested one is used."
                : "Left empty, no embeddings model is set.",
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="flex-1 hover:opacity-90">
          Save
        </Button>
        <SecondaryButton
          type="button"
          style={{ margin: "8px 0" }}
          className="flex-1"
          onClick={onCancel}
        >
          Cancel
        </SecondaryButton>
      </div>

      <button
        type="button"
        onClick={onChooseOtherProvider}
        className="cursor-pointer border-none bg-transparent p-0 text-center text-sm text-description-muted underline"
      >
        {OTHER_PROVIDER_LINK}
      </button>
    </form>
  );
}
