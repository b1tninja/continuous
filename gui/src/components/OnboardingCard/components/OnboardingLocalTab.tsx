import {
  LOCAL_ONBOARDING_CHAT_MODEL,
  LOCAL_ONBOARDING_CHAT_TITLE,
  LOCAL_ONBOARDING_EMBEDDINGS_MODEL,
  LOCAL_ONBOARDING_FIM_MODEL,
  LOCAL_ONBOARDING_PROVIDER_TITLE,
} from "core/config/onboarding";
import type { LocalOnboardingChoice } from "core";
import { OnboardingModes } from "core/protocol/core";
import { useContext, useEffect, useRef, useState } from "react";
import { Button, SecondaryButton } from "../..";
import { useAuth } from "../../../context/Auth";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppDispatch } from "../../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../../redux/slices/uiSlice";
import { updateSelectedModelByRole } from "../../../redux/thunks/updateSelectedModelByRole";
import { useOnboardingCard } from "../hooks/useOnboardingCard";
import { useSubmitOnboarding } from "../hooks/useSubmitOnboarding";
import { LOCAL_PROVIDER_CHOICES, LocalModelChooser } from "./LocalModelChooser";
import OllamaModelDownload from "./OllamaModelDownload";
import { OllamaStatus } from "./OllamaStatus";

const OLLAMA_CHECK_INTERVAL_MS = 3000;

interface OnboardingLocalTabProps {
  isDialog?: boolean;
  /**
   * The model or server the person chose instead of the suggested one. The
   * card keeps it while they look at another tab; without it the tab keeps it
   * itself.
   */
  choice?: LocalOnboardingChoice;
  onChoiceChange?: (choice: LocalOnboardingChoice) => void;
}

export function OnboardingLocalTab({
  isDialog,
  choice: choiceProp,
  onChoiceChange,
}: OnboardingLocalTabProps) {
  const [ownChoice, setOwnChoice] = useState<LocalOnboardingChoice>();
  const choice = onChoiceChange ? choiceProp : ownChoice;
  const [configuring, setConfiguring] = useState(false);
  const configureButton = useRef<HTMLButtonElement>(null);
  const wasConfiguring = useRef(false);
  const { setActiveTab } = useOnboardingCard();
  const isOllamaChoice = !choice || choice.provider === "ollama";
  const chatModelName = choice?.chatModel ?? LOCAL_ONBOARDING_CHAT_MODEL;
  const fimModelName = choice?.fimModel ?? LOCAL_ONBOARDING_FIM_MODEL;
  const embeddingsModelName =
    choice?.embeddingsModel ?? LOCAL_ONBOARDING_EMBEDDINGS_MODEL;
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const { submitOnboarding } = useSubmitOnboarding(
    OnboardingModes.LOCAL,
    isDialog,
  );
  const [hasLoadedChatModel, setHasLoadedChatModel] = useState(false);
  const [downloadedOllamaModels, setDownloadedOllamaModels] = useState<
    string[]
  >([]);
  const { selectedProfile } = useAuth();

  const [isOllamaConnected, setIsOllamaConnected] = useState(false);

  const hasDownloadedChatModel = Array.isArray(downloadedOllamaModels)
    ? downloadedOllamaModels.some(
        (ollamaModel) => ollamaModel === chatModelName,
      )
    : false;

  const hasDownloadedAutocompleteModel = Array.isArray(downloadedOllamaModels)
    ? downloadedOllamaModels.some((ollamaModel) => ollamaModel === fimModelName)
    : false;

  const hasDownloadedEmbeddingsModel = Array.isArray(downloadedOllamaModels)
    ? downloadedOllamaModels.some(
        (ollamaModel) => ollamaModel === embeddingsModelName,
      )
    : false;

  // Another server is not checked for here: nothing is asked of it until the
  // config is written.
  const allDownloaded =
    !isOllamaChoice ||
    (hasDownloadedAutocompleteModel &&
      hasDownloadedChatModel &&
      hasDownloadedEmbeddingsModel);

  /**
   * The first time we detect that a chat model has been loaded,
   * we send an empty request to load it
   */
  useEffect(() => {
    if (!hasLoadedChatModel && hasDownloadedChatModel) {
      ideMessenger.post("llm/complete", {
        completionOptions: {},
        prompt: "",
        title: LOCAL_ONBOARDING_PROVIDER_TITLE,
      });

      setHasLoadedChatModel(true);
    }
  }, [downloadedOllamaModels, isOllamaConnected]);

  useEffect(() => {
    // Another server's models are not Ollama's to list.
    if (!isOllamaChoice) return;
    const fetchDownloadedModels = async () => {
      try {
        const result = await ideMessenger.request("llm/listModels", {
          title: LOCAL_ONBOARDING_PROVIDER_TITLE,
        });
        if (result.status === "success") {
          setDownloadedOllamaModels(result.content ?? []);
          setIsOllamaConnected(!!result.content);
        } else {
          throw new Error("Failed to fetch models");
        }
      } catch (error) {
        console.error("Error fetching models:", error);
        setIsOllamaConnected(false);
      }
    };

    const intervalId = setInterval(
      fetchDownloadedModels,
      OLLAMA_CHECK_INTERVAL_MS,
    );

    void fetchDownloadedModels();

    return () => clearInterval(intervalId);
  }, [isOllamaChoice]);

  const onClickSubmitOnboarding = () => {
    submitOnboarding(choice);

    if (isDialog) {
      dispatch(setDialogMessage(undefined));
      dispatch(setShowDialog(false));
    }

    void dispatch(
      updateSelectedModelByRole({
        selectedProfile,
        role: "chat",
        modelTitle: choice
          ? choice.chatTitle || choice.chatModel
          : LOCAL_ONBOARDING_CHAT_TITLE,
      }),
    );
  };

  const onClickSkip = () => {
    submitOnboarding(choice);

    ideMessenger.post("config/openProfile", {
      profileId: undefined,
    });

    if (isDialog) {
      dispatch(setDialogMessage(undefined));
      dispatch(setShowDialog(false));
    }
  };

  useEffect(() => {
    if (wasConfiguring.current && !configuring) {
      configureButton.current?.focus();
    }
    wasConfiguring.current = configuring;
  }, [configuring]);

  function saveChoice(next: LocalOnboardingChoice) {
    (onChoiceChange ?? setOwnChoice)(next);
    setConfiguring(false);
  }

  if (configuring) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="w-full max-w-md">
          <LocalModelChooser
            initial={choice}
            installedModels={downloadedOllamaModels}
            onSave={saveChoice}
            onCancel={() => setConfiguring(false)}
            onChooseOtherProvider={() => setActiveTab(OnboardingModes.API_KEY)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mt-3 flex flex-col gap-1 px-2">
          {choice && (
            <div data-testid="local-choice-summary" className="flex flex-col">
              <p className="mb-1 text-sm leading-tight font-semibold text-foreground">
                Your model
              </p>
              <p className="m-0 text-sm break-all text-foreground">
                <span className="font-mono">{choice.chatModel}</span>
                <span className="text-description-muted">
                  {" "}
                  on{" "}
                  {LOCAL_PROVIDER_CHOICES.find(
                    (p) => p.provider === choice.provider,
                  )?.title ?? choice.provider}
                  {choice.apiBase ? ` at ${choice.apiBase}` : ""}
                </span>
              </p>
            </div>
          )}

          {isOllamaChoice && (
            <>
              <div className="flex flex-col">
                <p className="mb-1 text-sm leading-tight font-semibold text-foreground">
                  Install Ollama
                </p>
                <OllamaStatus isOllamaConnected={isOllamaConnected} />
              </div>

              <OllamaModelDownload
                title="Download Chat model"
                modelName={chatModelName}
                hasDownloaded={hasDownloadedChatModel}
              />

              <OllamaModelDownload
                title="Download Autocomplete model"
                modelName={fimModelName}
                hasDownloaded={hasDownloadedAutocompleteModel}
              />

              <OllamaModelDownload
                title="Download Embeddings model"
                modelName={embeddingsModelName}
                hasDownloaded={hasDownloadedEmbeddingsModel}
              />
            </>
          )}

          <div className="mt-4 w-full">
            <div className="flex flex-col gap-x-2 sm:flex-row">
              <Button
                onClick={onClickSubmitOnboarding}
                className="w-full cursor-pointer hover:opacity-90 sm:flex-1"
                disabled={!allDownloaded}
              >
                Connect
              </Button>
              <SecondaryButton
                ref={configureButton}
                type="button"
                onClick={() => setConfiguring(true)}
                style={{ margin: "8px 0" }}
                className="w-full cursor-pointer sm:flex-1"
              >
                Configure model
              </SecondaryButton>
            </div>
            <div className="w-full text-center">
              <span
                className="cursor-pointer text-description-muted underline"
                onClick={onClickSkip}
              >
                Skip and configure manually
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
