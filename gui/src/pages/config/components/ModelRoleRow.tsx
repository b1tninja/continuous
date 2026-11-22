import { ModelRole } from "@continuedev/config-yaml";
import {
  Cog6ToothIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { ModelDescription } from "core";
import { ReactNode } from "react";
import { MissingSecretsPopover } from "../../../components/config/MissingSecretsPopover";
import { ToolTip } from "../../../components/gui/Tooltip";
import { Button } from "../../../components/ui";
import {
  retirementDetail,
  retirementKey,
  useRetirementNotices,
} from "../../../hooks/useRetirementNotices";
import { useAppSelector } from "../../../redux/hooks";
import {
  missingSecretsForModel,
  missingSecretsFromErrors,
  missingSecretSummary,
  modelHasMissingSecret,
} from "../../../util/missingSecrets";
import ModelRoleSelector from "./ModelRoleSelector";

interface ModelRoleRowProps {
  role: ModelRole;
  displayName: string;
  description: string | ReactNode;
  models: ModelDescription[];
  selectedModel: ModelDescription | undefined;
  onSelect: (model: ModelDescription | null) => void;
  onConfigure: (model: ModelDescription | null) => void;
  setupURL: string;
  shortcut?: ReactNode;
}

export function ModelRoleRow({
  role,
  displayName,
  description,
  models,
  selectedModel,
  onSelect,
  onConfigure,
  setupURL,
  shortcut,
}: ModelRoleRowProps) {
  const configError = useAppSelector((state) => state.config.configError);
  // Show the warning only when the model picked for this role is affected.
  const missing = modelHasMissingSecret(selectedModel)
    ? missingSecretsForModel(
        missingSecretsFromErrors(configError),
        selectedModel?.title,
      )
    : [];
  const retirements = useRetirementNotices(
    selectedModel ? [selectedModel] : [],
  );
  const retirement = selectedModel
    ? retirements.get(
        retirementKey(selectedModel.provider, selectedModel.model),
      )
    : undefined;

  return (
    <div className="py-6 first:pt-0 last:pb-0">
      <div className="mb-2">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">{displayName}</span>
          {shortcut && shortcut}
        </div>
        <p className="mt-1 text-xs text-description">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1" data-testid={`model-role-${role}`}>
          <ModelRoleSelector
            displayName={displayName}
            description={description}
            models={models}
            selectedModel={selectedModel ?? null}
            onSelect={onSelect}
            setupURL={setupURL}
            hideTitle={true}
          />
        </div>
        {selectedModel && (
          <ToolTip content="Configure...">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Configure ${selectedModel.title}`}
              onClick={() => onConfigure(selectedModel)}
              className="my-0 h-6 w-6 p-0 text-description hover:enabled:text-foreground"
            >
              <Cog6ToothIcon className="h-4 w-4 shrink-0" />
            </Button>
          </ToolTip>
        )}
        {missing.length > 0 && (
          <MissingSecretsPopover
            missing={missing}
            ariaLabel={missingSecretSummary(missing)}
            buttonTestId={`model-row-key-not-set-${role}`}
          >
            <ToolTip content={missingSecretSummary(missing)}>
              <span>
                <ExclamationTriangleIcon
                  className="h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
              </span>
            </ToolTip>
          </MissingSecretsPopover>
        )}
      </div>
      {retirement && (
        <p
          className="mt-1.5 mb-0 flex items-start gap-1 text-xs text-warning"
          data-testid={`model-row-retirement-${role}`}
          title={retirementDetail(retirement)}
        >
          <ExclamationTriangleIcon
            className="mt-px h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>{retirement.message}</span>
        </p>
      )}
    </div>
  );
}
