import { ModelRole } from "@continuedev/config-yaml";
import { ModelDescription } from "core";
import { useContext, useState } from "react";
import Shortcut from "../../../components/gui/Shortcut";
import { useProviderSetupDialog } from "../../../components/ProviderSetup/useProviderSetupDialog";
import { useModelConfigDialog } from "../../../components/ModelConfig/useModelConfigDialog";
import { Card, Divider, Fold, useSectionLink } from "../../../components/ui";
import { useAuth } from "../../../context/Auth";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { updateSelectedModelByRole } from "../../../redux/thunks/updateSelectedModelByRole";
import { isJetBrains } from "../../../util";
import { reviewerCandidates } from "../../../util/reviewerModels";
import { ConfigHeader } from "../components/ConfigHeader";
import { ModelRoleRow } from "../components/ModelRoleRow";
import { AssignModelsCard } from "../components/AssignModelsCard";
import { ModeModelsTable } from "../components/ModeModelsTable";
import { ProviderInstancesCard } from "../components/ProviderInstancesCard";
import { ProvidersCard } from "../components/ProvidersCard";
import {
  accountsSummary,
  modeModelsSummary,
  modelInformationSummary,
  rolesSummary,
  type ModelInformationStatus,
} from "../modelsSummaries";
import { ModelInformationControl } from "./ModelInformationControl";

const MODEL_DOCS_URLS = {
  chat: {
    learnMore:
      "https://b1tninja.github.io/continuous/ide-extensions/chat/quick-start",
    setup:
      "https://b1tninja.github.io/continuous/ide-extensions/chat/model-setup",
  },
  autocomplete: {
    learnMore:
      "https://b1tninja.github.io/continuous/ide-extensions/autocomplete/quick-start",
    setup:
      "https://b1tninja.github.io/continuous/ide-extensions/autocomplete/model-setup",
  },
  edit: {
    learnMore:
      "https://b1tninja.github.io/continuous/ide-extensions/edit/quick-start",
    setup:
      "https://b1tninja.github.io/continuous/ide-extensions/edit/model-setup",
  },
} as const;

/**
 * Settings > Models: the models in use and the provider connections they come
 * from, then four folded groups (per-mode models, the other roles, the named
 * accounts, model information), each with its state in one line. The
 * connections and accounts were the Providers tab; `?tab=providers` lands on
 * Connections here.
 */
export function ModelsSection() {
  const { selectedProfile } = useAuth();
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);

  const config = useAppSelector((state) => state.config.config);
  const jetbrains = isJetBrains();
  // The folds whose state is read by the control inside them
  const [accounts, setAccounts] = useState<string[]>();
  const [modelInfo, setModelInfo] = useState<ModelInformationStatus>();
  const connectionsRef = useSectionLink<HTMLDivElement>("connections");

  function handleRoleUpdate(role: ModelRole, model: ModelDescription | null) {
    if (!model) {
      return;
    }

    void dispatch(
      updateSelectedModelByRole({
        role,
        selectedProfile,
        modelTitle: model.title,
      }),
    );
  }

  /** The reviewer is written to the active config (`modeModels.reviewer`), from any of its models. */
  function handleReviewerUpdate(model: ModelDescription | null) {
    if (!model) return;
    void ideMessenger.request("config/setModeModels", {
      reviewer: { model: model.title },
    });
  }

  const handleConfigureModel = useModelConfigDialog();

  const { openSetup } = useProviderSetupDialog();

  function handleAddModel() {
    openSetup();
  }

  return (
    <div className="space-y-4">
      <ConfigHeader
        title="Models"
        onAddClick={handleAddModel}
        addButtonTooltip="Manage models"
      />

      <h3 className="my-0 text-sm font-semibold">In use</h3>
      <Card>
        <ModelRoleRow
          role="chat"
          displayName="Chat"
          shortcut={
            <span className="text-2xs text-description-muted">
              (<Shortcut>{`cmd ${jetbrains ? "J" : "L"}`}</Shortcut>)
            </span>
          }
          description={
            <span>
              Used in Chat, Plan, Agent mode (
              <a
                href={MODEL_DOCS_URLS.chat.learnMore}
                target="_blank"
                rel="noopener noreferrer"
                className="text-inherit underline hover:brightness-125"
              >
                Learn more
              </a>
              )
            </span>
          }
          models={config.modelsByRole.chat}
          selectedModel={config.selectedModelByRole.chat ?? undefined}
          onSelect={(model) => handleRoleUpdate("chat", model)}
          onConfigure={handleConfigureModel}
          setupURL={MODEL_DOCS_URLS.chat.setup}
        />

        <Divider />

        <ModelRoleRow
          role="autocomplete"
          displayName="Autocomplete"
          description={
            <span>
              Used in inline code completions as you type (
              <a
                href={MODEL_DOCS_URLS.autocomplete.learnMore}
                target="_blank"
                rel="noopener noreferrer"
                className="text-inherit underline hover:brightness-125"
              >
                Learn more
              </a>
              )
            </span>
          }
          models={config.modelsByRole.autocomplete}
          selectedModel={config.selectedModelByRole.autocomplete ?? undefined}
          onSelect={(model) => handleRoleUpdate("autocomplete", model)}
          onConfigure={handleConfigureModel}
          setupURL={MODEL_DOCS_URLS.autocomplete.setup}
        />

        {/* Jetbrains has a model selector inline */}
        {!jetbrains && (
          <>
            <Divider />
            <ModelRoleRow
              role="edit"
              displayName="Edit"
              shortcut={
                <span className="text-2xs text-description-muted">
                  (<Shortcut>cmd I</Shortcut>)
                </span>
              }
              description={
                <span>
                  Used to transform a selected section of code (
                  <a
                    href={MODEL_DOCS_URLS.edit.learnMore}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-inherit underline hover:brightness-125"
                  >
                    Learn more
                  </a>
                  )
                </span>
              }
              models={config.modelsByRole.edit}
              selectedModel={config.selectedModelByRole.edit ?? undefined}
              onSelect={(model) => handleRoleUpdate("edit", model)}
              onConfigure={handleConfigureModel}
              setupURL={MODEL_DOCS_URLS.edit.setup}
            />
          </>
        )}
      </Card>

      <div ref={connectionsRef} data-testid="models-connections">
        <ProvidersCard />
      </div>

      {!jetbrains && (
        <Fold
          id="modes"
          title="Models per mode"
          summary={modeModelsSummary(config)}
        >
          <ModeModelsTable />
          {config.modelsByRole.chat.length === 0 && (
            <p className="my-0 text-xs text-description">
              Add a chat model first: a mode offers the chat models of the
              selected config.
            </p>
          )}
        </Fold>
      )}

      <Fold id="roles" title="Roles" summary={rolesSummary(config)}>
        <div className="space-y-4">
          <AssignModelsCard />

          <Card>
            <div className="mb-2">
              <div className="text-sm font-semibold">
                Additional model roles
              </div>
              <p className="my-1 text-xs text-description">
                Apply, Embed, Rerank, Reviewer
              </p>
            </div>
            <div className="flex flex-col">
              <ModelRoleRow
                role="apply"
                displayName="Apply"
                description="Used to apply generated codeblocks to files"
                models={config.modelsByRole.apply}
                selectedModel={config.selectedModelByRole.apply ?? undefined}
                onSelect={(model) => handleRoleUpdate("apply", model)}
                onConfigure={handleConfigureModel}
                setupURL="https://b1tninja.github.io/continuous/customize/model-roles/apply"
              />

              <Divider />

              <ModelRoleRow
                role="embed"
                displayName="Embed"
                description="Used to generate and query embeddings for the @codebase and @docs context providers"
                models={config.modelsByRole.embed}
                selectedModel={config.selectedModelByRole.embed ?? undefined}
                onSelect={(model) => handleRoleUpdate("embed", model)}
                onConfigure={handleConfigureModel}
                setupURL="https://b1tninja.github.io/continuous/customize/model-roles/embeddings"
              />

              <Divider />

              <ModelRoleRow
                role="rerank"
                displayName="Rerank"
                description="Used for reranking results from the @codebase and @docs context providers"
                models={config.modelsByRole.rerank}
                selectedModel={config.selectedModelByRole.rerank ?? undefined}
                onSelect={(model) => handleRoleUpdate("rerank", model)}
                onConfigure={handleConfigureModel}
                setupURL="https://b1tninja.github.io/continuous/customize/model-roles/reranking"
              />

              {config.experimental?.enableAutoApproval && (
                <>
                  <Divider />

                  <ModelRoleRow
                    role="reviewer"
                    displayName="Reviewer (experimental)"
                    description="Reviews tool calls in Auto approval mode. Any model in the active config, from any provider. Your messages and the tool calls are sent to this model's provider."
                    models={reviewerCandidates(config.modelsByRole)}
                    selectedModel={
                      config.selectedModelByRole.reviewer ?? undefined
                    }
                    onSelect={handleReviewerUpdate}
                    onConfigure={handleConfigureModel}
                    setupURL="https://b1tninja.github.io/continuous/customize/model-roles/reviewer"
                  />
                </>
              )}
            </div>
          </Card>
        </div>
      </Fold>

      <Fold id="accounts" title="Accounts" summary={accountsSummary(accounts)}>
        <ProviderInstancesCard onAccounts={setAccounts} />
      </Fold>

      <Fold
        id="model-information"
        title="Model information"
        summary={modelInformationSummary(modelInfo)}
      >
        <ModelInformationControl onStatus={setModelInfo} />
      </Fold>
    </div>
  );
}
