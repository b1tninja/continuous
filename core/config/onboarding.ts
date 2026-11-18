import { ConfigYaml } from "@continuedev/config-yaml";
import type { LocalOnboardingChoice } from "../index.js";

export const LOCAL_ONBOARDING_PROVIDER_TITLE = "Ollama";
export const LOCAL_ONBOARDING_FIM_MODEL = "qwen2.5-coder:1.5b-base";
export const LOCAL_ONBOARDING_FIM_TITLE = "Qwen2.5-Coder 1.5B";
export const LOCAL_ONBOARDING_CHAT_MODEL = "llama3.1:8b";
export const LOCAL_ONBOARDING_CHAT_TITLE = "Llama 3.1 8B";
export const LOCAL_ONBOARDING_EMBEDDINGS_MODEL = "nomic-embed-text:latest";
export const LOCAL_ONBOARDING_EMBEDDINGS_TITLE = "Nomic Embed";

/** Why a model name cannot be used, or undefined when it can. */
export function validateLocalModelName(name: string): string | undefined {
  const value = name.trim();
  if (!value) return "Enter a model name.";
  if (/\s/.test(value)) return "A model name has no spaces.";
  return undefined;
}

/** Why a server address cannot be used, or undefined when it can. */
export function validateLocalApiBase(apiBase: string): string | undefined {
  const value = apiBase.trim();
  if (!value) return "Enter the server address.";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "The address must start with http:// or https://.";
    }
  } catch {
    return "Enter a full address, such as http://127.0.0.1:8080/v1/.";
  }
  return undefined;
}

function titleFor(model: string, suggested: string, suggestedTitle: string) {
  return model === suggested ? suggestedTitle : model;
}

/**
 * The models block for a person's own choice: the chat model, and the
 * autocomplete and embeddings models when there is one. Ollama keeps the
 * suggested autocomplete and embeddings models unless another is named, as
 * those are pulled together with the chat model; any other server gets only
 * the models that were named, as it may not serve the suggested ones.
 */
function localChoiceModels(choice: LocalOnboardingChoice) {
  const isOllama = choice.provider === "ollama";
  const apiBase = choice.apiBase?.trim() || undefined;
  const base = { provider: choice.provider, ...(apiBase ? { apiBase } : {}) };
  const chatModel = choice.chatModel.trim();
  const fimModel =
    choice.fimModel?.trim() || (isOllama ? LOCAL_ONBOARDING_FIM_MODEL : "");
  const embeddingsModel =
    choice.embeddingsModel?.trim() ||
    (isOllama ? LOCAL_ONBOARDING_EMBEDDINGS_MODEL : "");

  return [
    {
      name:
        choice.chatTitle?.trim() ||
        titleFor(
          chatModel,
          LOCAL_ONBOARDING_CHAT_MODEL,
          LOCAL_ONBOARDING_CHAT_TITLE,
        ),
      ...base,
      model: chatModel,
      roles: ["chat", "edit", "apply"] as ("chat" | "edit" | "apply")[],
    },
    ...(fimModel
      ? [
          {
            name: titleFor(
              fimModel,
              LOCAL_ONBOARDING_FIM_MODEL,
              LOCAL_ONBOARDING_FIM_TITLE,
            ),
            ...base,
            model: fimModel,
            roles: ["autocomplete"] as "autocomplete"[],
          },
        ]
      : []),
    ...(embeddingsModel
      ? [
          {
            name: titleFor(
              embeddingsModel,
              LOCAL_ONBOARDING_EMBEDDINGS_MODEL,
              LOCAL_ONBOARDING_EMBEDDINGS_TITLE,
            ),
            ...base,
            model: embeddingsModel,
            roles: ["embed"] as "embed"[],
          },
        ]
      : []),
  ];
}

/**
 * Puts a local setup first in config.yaml: the suggested Ollama one, or
 * `choice` when the person picked their own model or server.
 */
export function setupLocalConfig(
  config: ConfigYaml,
  choice?: LocalOnboardingChoice,
): ConfigYaml {
  if (choice) {
    return {
      ...config,
      models: [...localChoiceModels(choice), ...(config.models ?? [])],
    };
  }
  return {
    ...config,
    models: [
      {
        name: LOCAL_ONBOARDING_CHAT_TITLE,
        provider: "ollama",
        model: LOCAL_ONBOARDING_CHAT_MODEL,
        roles: ["chat", "edit", "apply"],
      },
      {
        name: LOCAL_ONBOARDING_FIM_TITLE,
        provider: "ollama",
        model: LOCAL_ONBOARDING_FIM_MODEL,
        roles: ["autocomplete"],
      },
      {
        name: LOCAL_ONBOARDING_EMBEDDINGS_TITLE,
        provider: "ollama",
        model: LOCAL_ONBOARDING_EMBEDDINGS_MODEL,
        roles: ["embed"],
      },
      ...(config.models ?? []),
    ],
  };
}
