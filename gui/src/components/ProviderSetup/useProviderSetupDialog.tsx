import type { ProviderConnectionKey } from "core/config/providerSetup";
import { useCallback } from "react";
import { useAppDispatch } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { ProviderSetupFlow } from "./ProviderSetupFlow";
import type { SetupStep } from "./providerSetupUtils";

export interface OpenProviderSetupOptions {
  initialProvider?: string;
  /** Edit this configured connection. */
  initialConnection?: ProviderConnectionKey;
  /**
   * The step to open at when editing a connection: "models" for its model
   * checklist (Manage models), "credentials" (the default) for the rest.
   */
  initialStep?: SetupStep;
  /** Called after the setup was saved. */
  onSaved?: () => void;
}

/**
 * Opens the provider setup flow in the app dialog. Every entry point (model
 * picker, Models tab, Providers page, missing-key popover) goes through here.
 */
export function useProviderSetupDialog() {
  const dispatch = useAppDispatch();

  const close = useCallback(() => {
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  }, [dispatch]);

  const openSetup = useCallback(
    (options: OpenProviderSetupOptions = {}) => {
      dispatch(setShowDialog(true));
      dispatch(
        setDialogMessage(
          <ProviderSetupFlow
            initialProvider={options.initialProvider}
            initialConnection={options.initialConnection}
            initialStep={options.initialStep}
            onDone={() => {
              close();
              options.onSaved?.();
            }}
            onCancel={close}
          />,
        ),
      );
    },
    [dispatch, close],
  );

  /** Ask for the value of a secret that config.yaml refers to. */
  const openEnterKey = useCallback(
    (secret: { secretName: string; provider?: string }) => {
      dispatch(setShowDialog(true));
      dispatch(
        setDialogMessage(
          <ProviderSetupFlow
            initialProvider={secret.provider}
            enterKey={{ secretName: secret.secretName }}
            onDone={close}
            onCancel={close}
          />,
        ),
      );
    },
    [dispatch, close],
  );

  return { openSetup, openEnterKey };
}
