import { XMarkIcon } from "@heroicons/react/24/outline";
import { useContext } from "react";
import { useNavigate } from "react-router-dom";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { updateConfig } from "../../redux/slices/configSlice";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { CONFIG_ROUTES } from "../../util/navigation";
import { modifyAnyConfigWithSharedConfig } from "core/config/sharedConfig";

/**
 * One line for a first-time user, shown in an empty chat. It shares the
 * `permissionsIntroDismissed` flag with the Permissions page card, so once
 * either is dismissed neither comes back.
 */
export function FirstRunNotice() {
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const config = useAppSelector((s) => s.config.config);

  if (config.ui?.permissionsIntroDismissed === true) {
    return null;
  }

  const dismiss = () => {
    const shared = { permissionsIntroDismissed: true };
    dispatch(updateConfig(modifyAnyConfigWithSharedConfig(config, shared)));
    ideMessenger.post("config/updateSharedConfig", shared);
  };

  return (
    <div
      role="note"
      aria-label="First-run tip"
      data-testid="first-run-notice"
      className="mx-2 mt-2 flex min-w-0 items-start gap-2 rounded-sm border border-solid border-border bg-input px-2 py-1"
    >
      <p className="m-0 min-w-0 flex-1 text-xs text-description-muted">
        New here? Each area has a level and a preset sets them all; locked rules
        apply first.{" "}
        <a
          href={CONFIG_ROUTES.PERMISSIONS}
          onClick={(e) => {
            e.preventDefault();
            void navigate(CONFIG_ROUTES.PERMISSIONS);
          }}
          className="inline-flex min-h-6 items-center text-link underline"
          data-testid="first-run-notice-link"
        >
          Open Permissions
        </a>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss the first-run tip"
        data-testid="first-run-notice-dismiss"
        className="flex h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded-sm border border-solid border-transparent bg-transparent p-0 text-foreground hover:opacity-80"
      >
        <XMarkIcon className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
