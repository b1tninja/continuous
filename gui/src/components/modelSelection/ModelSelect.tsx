import {
  ArrowPathIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  CubeIcon,
  PlusIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import type { RetirementNotice } from "core/util/modelRetirement";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/Auth";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import {
  retirementDetail,
  retirementKey,
  retirementLabel,
  useRetirementNotices,
} from "../../hooks/useRetirementNotices";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectCacheSetting } from "../../redux/selectors/selectCacheSetting";
import {
  setDialogMessage,
  setModeModelOverride,
  setShowDialog,
} from "../../redux/slices/uiSlice";
import { isLocalModel } from "../../redux/thunks/prepareCompaction";
import { updateSelectedModelByRole } from "../../redux/thunks/updateSelectedModelByRole";
import { getMetaKeyLabel, isMetaEquivalentKeyPressed } from "../../util";
import {
  isSignificantLoss,
  switchKeepsCache,
  warmCacheLoss,
} from "../../util/cacheSafeguards";
import { modelHasMissingSecret } from "../../util/missingSecrets";
import {
  getModeModelTitles,
  nextModelTitle,
  partitionModelsByMode,
} from "../../util/modeModels";
import { CONFIG_ROUTES } from "../../util/navigation";
import { useModelConfigDialog } from "../ModelConfig/useModelConfigDialog";
import { connectionForModel } from "../ProviderSetup/providerSetupUtils";
import { useProviderSetupDialog } from "../ProviderSetup/useProviderSetupDialog";
import {
  Button,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  useFontSize,
} from "../ui";
import { Divider } from "../ui/Divider";
import { ModelSwitchCacheNotice } from "./ModelSwitchCacheNotice";
import { ModelSwitchConfirm } from "./ModelSwitchConfirm";

interface ModelOptionProps {
  option: Option;
  idx: number;
  showMissingApiKeyMsg: boolean;
  isSelected?: boolean;
  /** Deprecated, retired or retiring soon (core/util/modelRetirement.ts). */
  retirement?: RetirementNotice;
}

interface Option {
  value: string;
  title: string;
  apiKey?: string;
  sourceFile?: string;
  isAutoDetected?: boolean;
  /** A `${{ secrets.* }}` credential with no value on this machine. */
  missingSecret?: boolean;
  provider?: string;
  model?: string;
  /** No window is set or published: 32,768 tokens is assumed. */
  contextUnknown?: boolean;
  /**
   * The window a local server reported for the model (Ollama: the one it
   * loaded it with). It depends on the machine, so the row gives the number.
   */
  serverWindow?: number;
}

function modelSelectTitle(model: any): string {
  if (model?.title) return model?.title;
  if (model?.model !== undefined && model?.model.trim() !== "") {
    if (model?.class_name) {
      return `${model?.class_name} - ${model?.model}`;
    }
    return model?.model;
  }
  return model?.class_name;
}

/**makeshift way to close the headlessui listbox due to absence of open state on the listbox */
function closeDropDown(button: HTMLButtonElement | null) {
  if (!button) return;
  button.classList.add("hidden");
  setTimeout(() => {
    button.classList.remove("hidden");
  });
}

function ModelOption({
  option,
  idx,
  showMissingApiKeyMsg,
  isSelected,
  retirement,
}: ModelOptionProps) {
  const openModelConfig = useModelConfigDialog();

  function handleOptionClick(e: any) {
    if (showMissingApiKeyMsg) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function handleConfigureClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    openModelConfig({ title: option.value, sourceFile: option.sourceFile });
  }

  return (
    <ListboxOption
      key={idx}
      disabled={showMissingApiKeyMsg}
      value={option.value}
      onClick={handleOptionClick}
      className={`group ${isSelected ? "bg-list-active text-list-active-foreground" : ""}`}
    >
      <div className="flex w-full items-center justify-between gap-5">
        <div className="flex items-center gap-2 py-0.5">
          <CubeIcon className="h-3 w-3 shrink-0" />
          <span className="line-clamp-1">
            {option.title}
            {option.isAutoDetected && (
              <span className="ml-1.5 text-[10px] text-description-muted italic">
                (autodetected)
              </span>
            )}
            {showMissingApiKeyMsg && (
              <span className="ml-1.5 text-[10px] italic">
                (Missing API key)
              </span>
            )}
            {option.missingSecret && (
              <span
                className="ml-1.5 text-[10px] text-warning italic"
                data-testid="model-option-key-not-set"
              >
                (Key not set)
              </span>
            )}
            {option.contextUnknown && (
              <span
                className="ml-1.5 text-[10px] text-warning italic"
                data-testid="model-option-window-unknown"
                title="No context window is known for this model, so 32,768 tokens is assumed. Open Configure to set it."
              >
                (Window unknown)
              </span>
            )}
            {option.serverWindow !== undefined && (
              <span
                className="ml-1.5 text-[10px] text-description-muted italic"
                data-testid="model-option-server-window"
                title={`This model's server reported a context window of ${option.serverWindow.toLocaleString("en-US")} tokens. Open Configure to set your own.`}
              >
                ({option.serverWindow.toLocaleString("en-US")} tokens, from the
                server)
              </span>
            )}
            {retirement && (
              <span
                className="ml-1.5 text-[10px] text-warning italic"
                data-testid="model-option-retirement"
                title={retirementDetail(retirement)}
              >
                ({retirementLabel(retirement)})
              </span>
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Configure ${option.title}`}
          className="my-0 h-4 w-4 p-0 text-description-muted opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 hover:enabled:text-foreground"
          onClick={handleConfigureClick}
        >
          <Cog6ToothIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </ListboxOption>
  );
}

/** Dispatch on window to open the chat model picker. */
export const OPEN_MODEL_SELECT_EVENT = "continuous:openModelSelect";

function ModelSelect() {
  const dispatch = useAppDispatch();
  const { openSetup } = useProviderSetupDialog();
  const ideMessenger = useContext(IdeMessengerContext);
  const navigate = useNavigate();

  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const config = useAppSelector((state) => state.config.config);
  const isConfigLoading = useAppSelector((state) => state.config.loading);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Opened from elsewhere, e.g. "Change model" after a failed request
  useEffect(() => {
    const open = () => buttonRef.current?.click();
    window.addEventListener(OPEN_MODEL_SELECT_EVENT, open);
    return () => window.removeEventListener(OPEN_MODEL_SELECT_EVENT, open);
  }, []);
  const [options, setOptions] = useState<Option[]>([]);
  const [sortedOptions, setSortedOptions] = useState<Option[]>([]);
  const retirements = useRetirementNotices(options);
  const { selectedProfile } = useAuth();
  const mode = useAppSelector((state) => state.session.mode);
  const tinyFont = useFontSize(-4);
  // The keyboard shortcut is bound once per change of its dependencies, so it
  // reaches the current `chooseModel` (which reads the cache state) via a ref.
  const chooseModelRef = useRef<(title: string) => void>(() => {});

  let selectedModel = null;
  let allModels = null;
  if (isInEdit) {
    allModels = config.modelsByRole.edit;
    selectedModel = config.selectedModelByRole.edit;
  }
  if (!selectedModel) {
    selectedModel = config.selectedModelByRole.chat;
  }
  if (!allModels || allModels.length === 0) {
    allModels = config.modelsByRole.chat;
  }

  // Sort so that options without an API key are at the end
  useEffect(() => {
    const alphaSort = options.sort((a, b) => a.title.localeCompare(b.title));
    const enabledOptions = alphaSort.filter((option) => option.apiKey !== "");
    const disabledOptions = alphaSort.filter((option) => option.apiKey === "");

    const sorted = [...enabledOptions, ...disabledOptions];

    setSortedOptions(sorted);
  }, [options]);

  // `modeModels.<mode>.models`: the models this mode offers. Edit mode has its
  // own model list, so the per-mode list does not apply there.
  const modeTitles = isInEdit ? undefined : getModeModelTitles(config, mode);
  const { offered: offeredOptions, rest: otherOptions } = useMemo(
    () => partitionModelsByMode(options, modeTitles),
    [options, modeTitles?.join("\u0000")],
  );
  const { offered: offeredSorted, rest: otherSorted } = useMemo(
    () => partitionModelsByMode(sortedOptions, modeTitles),
    [sortedOptions, modeTitles?.join("\u0000")],
  );
  const modeLabel =
    mode === "plan" ? "Plan" : mode === "agent" ? "Agent" : "Chat";

  useEffect(() => {
    setOptions(
      allModels.map((model) => {
        return {
          value: model.title,
          title: modelSelectTitle(model),
          apiKey: model.apiKey,
          sourceFile: model.sourceFile,
          isAutoDetected: model.isFromAutoDetect,
          missingSecret: modelHasMissingSecret(model),
          provider: model.provider,
          model: model.model,
          contextUnknown: model.contextLengthSource === "unknown",
          serverWindow:
            model.contextLengthSource === "provider" &&
            model.contextLength &&
            isLocalModel(model)
              ? model.contextLength
              : undefined,
        };
      }),
    );
  }, [allModels]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "'" &&
        isMetaEquivalentKeyPressed(event as any) &&
        !event.shiftKey // To prevent collisions w/ assistant toggle logic
      ) {
        if (!selectedProfile) {
          return;
        }

        // Cycle only the models this mode offers; with no list, all of them.
        const candidates = offeredOptions.length > 0 ? offeredOptions : options;
        const newModelTitle = nextModelTitle(
          candidates,
          selectedModel?.title,
          1,
        );
        if (!newModelTitle) return;

        chooseModelRef.current(newModelTitle);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [options, offeredOptions, selectedModel, mode, selectedProfile]);

  const cacheSetting = useAppSelector(selectCacheSetting);
  const cacheState = useAppSelector((state) => state.session.promptCache);

  /** Changes the chat or edit model, as a manual pick for this mode. */
  function applyModelChoice(title: string) {
    // A manual pick wins over `modeModels` for this mode until reload.
    if (!isInEdit) {
      void dispatch(setModeModelOverride({ mode, title }));
    }
    void dispatch(
      updateSelectedModelByRole({
        selectedProfile,
        role: isInEdit ? "edit" : "chat",
        modelTitle: title,
      }),
    );
  }

  /**
   * Switches model, first asking when the prompt cache is warm and the
   * conversation is big enough that re-reading it at full price is real money.
   */
  function chooseModel(title: string) {
    if (title === config.selectedModelByRole.chat?.title && !isInEdit) return;
    if (isInEdit && title === config.selectedModelByRole.edit?.title) return;
    const pool = isInEdit ? config.modelsByRole.edit : config.modelsByRole.chat;
    const target = (pool.length > 0 ? pool : config.modelsByRole.chat).find(
      (m) => m.title === title,
    );
    const current = config.selectedModelByRole.chat;
    // Variants of one model (Name#plan, Name#act) are the same model on the
    // same server: switching does not throw a cache away
    const loss =
      !isInEdit &&
      current &&
      target &&
      cacheState &&
      !switchKeepsCache(current, target)
        ? warmCacheLoss(current, cacheSetting, cacheState, Date.now(), target)
        : undefined;
    if (!loss || !isSignificantLoss(loss)) {
      applyModelChoice(title);
      return;
    }
    closeDropDown(buttonRef.current);
    dispatch(
      setDialogMessage(
        <ModelSwitchConfirm
          from={current!.title}
          to={title}
          loss={loss}
          onSwitch={() => applyModelChoice(title)}
          onSwitchInNewSession={() => applyModelChoice(title)}
        />,
      ),
    );
    dispatch(setShowDialog(true));
  }
  chooseModelRef.current = chooseModel;

  /** "Add a model": the setup flow from its start screen (what the person has). */
  function onClickAddNewModel(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    closeDropDown(buttonRef.current);
    openSetup();
  }

  function onClickAddModel(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    closeDropDown(buttonRef.current);

    // Open where the current model is configured: its provider connection, at
    // the model checklist. Without a match (a model no connection lists), the
    // plain add-provider flow.
    const title =
      (isInEdit ? config.selectedModelByRole.edit : undefined)?.title ??
      config.selectedModelByRole.chat?.title;
    void ideMessenger
      .request("config/getProviderSetup", undefined)
      .then((res) => {
        const found =
          res.status === "success"
            ? connectionForModel(res.content.connections, title)
            : undefined;
        if (found) {
          openSetup({
            initialProvider: found.provider,
            initialConnection: found.connection,
            initialStep: "models",
          });
        } else {
          openSetup();
        }
      })
      .catch(() => openSetup());
  }

  function onClickProviders(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    closeDropDown(buttonRef.current);

    void navigate(CONFIG_ROUTES.PROVIDERS);
  }

  function onClickConfigureModels(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();

    closeDropDown(buttonRef.current);

    navigate(CONFIG_ROUTES.MODELS);
  }

  const hasNoModels = allModels?.length === 0;
  const selectedKeyNotSet = modelHasMissingSecret(selectedModel);

  return (
    <Listbox
      onChange={(val: string) =>
        // Enter on the Providers... row opens the page, as a click does
        val === "providers"
          ? navigate(CONFIG_ROUTES.PROVIDERS)
          : val === "addNewModel"
            ? openSetup()
            : chooseModel(val)
      }
    >
      <div className="relative flex min-w-0">
        <ListboxButton
          data-testid="model-select-button"
          ref={buttonRef}
          className="h-6 max-w-full min-w-0 gap-1 border-none text-description"
        >
          <span
            className="truncate hover:brightness-110"
            title={modelSelectTitle(selectedModel) || "Select model"}
          >
            {modelSelectTitle(selectedModel) || "Select model"}
          </span>
          <ChevronDownIcon
            className="hidden h-2 w-2 shrink-0 hover:brightness-110 min-[200px]:flex"
            aria-hidden="true"
          />
        </ListboxButton>
        <ListboxOptions className="min-w-[160px]">
          <div className="flex items-center justify-between px-1.5 py-1">
            <span className="text-xs font-medium text-description">Models</span>
            <div className="flex items-center gap-0.5">
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onClickConfigureModels(e);
                }}
                variant="ghost"
                size="sm"
                aria-label="Configure models"
                title="Configure models"
                className="relative my-0 h-6 w-6 p-0"
                data-testid="model-select-configure"
              >
                <Cog6ToothIcon className="h-3.5 w-3.5 text-description" />
                {selectedKeyNotSet && (
                  <span
                    className="absolute top-0 right-0 h-1.5 w-1.5 rounded-full bg-warning"
                    data-testid="model-select-key-not-set-dot"
                    title="Key not set on this machine"
                  />
                )}
              </Button>
            </div>
          </div>

          <div className="no-scrollbar max-h-[300px] overflow-y-auto">
            {isConfigLoading ? (
              <div className="flex items-center gap-2 px-2 pt-1 pb-2 text-xs text-description">
                <ArrowPathIcon className="h-3 w-3 animate-spin-slow" />
                <span>Loading config</span>
              </div>
            ) : hasNoModels ? (
              <div className="px-2 py-4 text-center text-sm text-description-muted">
                No models configured
              </div>
            ) : offeredSorted.length > 0 ? (
              <>
                <div
                  className="px-2 pt-1 pb-0.5 text-[10px] tracking-wide text-description-muted uppercase"
                  data-testid="model-group-mode"
                >
                  {modeLabel} models
                </div>
                {offeredSorted.map((option) => (
                  <ModelOption
                    option={option}
                    idx={options.indexOf(option)}
                    key={`offered-${option.value}`}
                    showMissingApiKeyMsg={option.apiKey === ""}
                    isSelected={option.value === selectedModel?.title}
                    retirement={retirements.get(
                      retirementKey(option.provider, option.model),
                    )}
                  />
                ))}
                {otherSorted.length > 0 && (
                  <>
                    <div
                      className="px-2 pt-2 pb-0.5 text-[10px] tracking-wide text-description-muted uppercase"
                      data-testid="model-group-all"
                    >
                      All models
                    </div>
                    {otherSorted.map((option) => (
                      <ModelOption
                        option={option}
                        idx={options.indexOf(option)}
                        key={`other-${option.value}`}
                        showMissingApiKeyMsg={option.apiKey === ""}
                        isSelected={option.value === selectedModel?.title}
                        retirement={retirements.get(
                          retirementKey(option.provider, option.model),
                        )}
                      />
                    ))}
                  </>
                )}
              </>
            ) : (
              sortedOptions.map((option, idx) => (
                <ModelOption
                  option={option}
                  idx={idx}
                  key={idx}
                  showMissingApiKeyMsg={option.apiKey === ""}
                  isSelected={option.value === selectedModel?.title}
                  retirement={retirements.get(
                    retirementKey(option.provider, option.model),
                  )}
                />
              ))
            )}
          </div>

          {!isConfigLoading && (
            <>
              <ModelSwitchCacheNotice />
              <Divider className="!mb-0" />
              <ListboxOption
                key={options.length + 2}
                onClick={onClickAddNewModel}
                value={"addNewModel" as any}
                fontSizeModifier={-2}
                className="px-2 py-2"
              >
                <span className="flex flex-row items-center text-2xs text-description">
                  <PlusIcon className="mr-1.5 h-3.5 w-3.5" />
                  Add a model...
                </span>
              </ListboxOption>
              <ListboxOption
                key={options.length}
                onClick={onClickAddModel}
                value={"addModel" as any}
                fontSizeModifier={-2}
                className="px-2 py-2"
              >
                <span className="flex flex-row items-center text-2xs text-description">
                  <Cog6ToothIcon className="mr-1.5 h-3.5 w-3.5" />
                  Manage models...
                </span>
              </ListboxOption>
              <ListboxOption
                key={options.length + 1}
                onClick={onClickProviders}
                value={"providers" as any}
                fontSizeModifier={-2}
                className="px-2 py-2"
              >
                <span className="flex flex-row items-center text-2xs text-description">
                  <ServerStackIcon className="mr-1.5 h-3.5 w-3.5" />
                  Providers...
                </span>
              </ListboxOption>

              <Divider className="!my-0" />
              <div className="flex items-center justify-start p-2 text-description">
                <span className="block" style={{ fontSize: tinyFont }}>
                  <code>{getMetaKeyLabel()}'</code> to toggle{" "}
                  {offeredOptions.length > 0 ? `${modeLabel} models` : "model"}
                </span>
              </div>
            </>
          )}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

export default ModelSelect;
