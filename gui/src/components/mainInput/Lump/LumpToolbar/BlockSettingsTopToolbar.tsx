import {
  CubeIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  PencilIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { useContext, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import {
  selectPendingToolCalls,
  selectToolCallsByStatus,
} from "../../../../redux/selectors/selectToolCalls";
import { setSelectedProfile } from "../../../../redux/slices/profilesSlice";
import { ToolTip } from "../../../gui/Tooltip";
import HoverItem from "../../InputToolbar/HoverItem";

import { useAuth } from "../../../../context/Auth";
import { CONFIG_ROUTES } from "../../../../util/navigation";
import { AssistantAndOrgListbox } from "../../../AssistantAndOrgListbox";
import { MissingSecretsPopover } from "../../../config/MissingSecretsPopover";
import {
  missingSecretsFromErrors,
  missingSecretSummary,
  otherErrors,
} from "../../../../util/missingSecrets";

export function BlockSettingsTopToolbar() {
  const navigate = useNavigate();
  // Below md the three shortcuts fold behind a toggle; not saved
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const dispatch = useAppDispatch();
  const { selectedProfile } = useAuth();

  const configError = useAppSelector((store) => store.config.configError);
  const ideMessenger = useContext(IdeMessengerContext);

  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const callingToolCalls = useAppSelector((state) =>
    selectToolCallsByStatus(state, "calling"),
  );
  const hasActiveContent =
    pendingToolCalls.length > 0 || callingToolCalls.length > 0;

  const shouldShowError = configError && configError?.length > 0;

  const missingSecrets = missingSecretsFromErrors(configError);
  const otherConfigErrors = otherErrors(configError);
  // Only a missing key is wrong: say which one, and offer the fix right here.
  // Any other error keeps today's behaviour (open the Configs tab).
  const onlyMissingSecrets =
    missingSecrets.length > 0 && otherConfigErrors.length === 0;

  const handleRulesClick = () => {
    if (selectedProfile) {
      dispatch(setSelectedProfile(selectedProfile.id));
      ideMessenger.post("didChangeSelectedProfile", {
        id: selectedProfile.id,
      });
    }
    navigate(CONFIG_ROUTES.RULES);
  };

  const handleToolsClick = () => {
    if (selectedProfile) {
      dispatch(setSelectedProfile(selectedProfile.id));
      ideMessenger.post("didChangeSelectedProfile", {
        id: selectedProfile.id,
      });
    }
    navigate(CONFIG_ROUTES.TOOLS);
  };

  const handleModelsClick = () => {
    if (selectedProfile) {
      dispatch(setSelectedProfile(selectedProfile.id));
      ideMessenger.post("didChangeSelectedProfile", {
        id: selectedProfile.id,
      });
    }
    navigate(CONFIG_ROUTES.MODELS);
  };

  const SHORTCUTS: [string, typeof PencilIcon, () => void][] = [
    ["Configure rules", PencilIcon, handleRulesClick],
    ["Configure tools", WrenchScrewdriverIcon, handleToolsClick],
    ["Configure models", CubeIcon, handleModelsClick],
  ];

  return (
    <div className="flex flex-1 flex-wrap items-center justify-between gap-1 md:gap-3">
      <div className="flex items-center gap-1">
        {shouldShowError && onlyMissingSecrets && (
          <ToolTip
            delayShow={700}
            content={missingSecretSummary(missingSecrets)}
          >
            <div data-testid="block-settings-toolbar-icon-missing-secret">
              <MissingSecretsPopover
                missing={missingSecrets}
                ariaLabel={missingSecretSummary(missingSecrets)}
                buttonTestId="block-settings-toolbar-icon-error"
                className="flex items-center rounded-full px-1.5 py-1 sm:px-1.5"
              >
                <ExclamationTriangleIcon
                  className="h-[13px] w-[13px] shrink-0 text-warning"
                  aria-hidden="true"
                />
              </MissingSecretsPopover>
            </div>
          </ToolTip>
        )}

        {shouldShowError && !onlyMissingSecrets && (
          <ToolTip
            delayShow={700}
            content={
              missingSecrets.length > 0
                ? `${missingSecretSummary(missingSecrets)}. View configuration errors`
                : "View configuration errors"
            }
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => navigate(CONFIG_ROUTES.CONFIGS)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(CONFIG_ROUTES.CONFIGS);
                }
              }}
              data-testid="block-settings-toolbar-icon-error"
              className="relative flex cursor-pointer items-center rounded-full px-1.5 py-1 select-none sm:px-1.5"
            >
              <ExclamationTriangleIcon
                className="h-[13px] w-[13px] shrink-0 text-warning"
                aria-hidden="true"
              />
            </div>
          </ToolTip>
        )}

        {!hasActiveContent && (
          <>
            <button
              type="button"
              data-testid="block-settings-shortcuts-toggle"
              aria-label={
                shortcutsOpen
                  ? "Hide rules, tools and models shortcuts"
                  : "Show rules, tools and models shortcuts"
              }
              aria-expanded={shortcutsOpen}
              aria-controls="block-settings-shortcuts"
              onClick={() => setShortcutsOpen((open) => !open)}
              className="hover:bg-list-item-hover flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-description-muted md:hidden"
            >
              <EllipsisHorizontalIcon className="h-3 w-3" aria-hidden="true" />
            </button>
            <div
              id="block-settings-shortcuts"
              className={`${shortcutsOpen ? "flex" : "hidden"} items-center gap-1.5 md:flex`}
            >
              {SHORTCUTS.map(([label, Icon, go]) => (
                <ToolTip key={label} content={label}>
                  <HoverItem
                    as="button"
                    type="button"
                    aria-label={label}
                    onClick={() => go()}
                    px={2}
                    className="min-h-6 min-w-6 justify-center border-none bg-transparent"
                  >
                    <Icon
                      className="h-3 w-3 text-description-muted hover:brightness-125"
                      aria-hidden="true"
                    />
                  </HoverItem>
                </ToolTip>
              ))}
            </div>
          </>
        )}
      </div>

      <ToolTip place="top" content="Select Config">
        <div>
          <AssistantAndOrgListbox variant="lump" />
        </div>
      </ToolTip>
    </div>
  );
}
