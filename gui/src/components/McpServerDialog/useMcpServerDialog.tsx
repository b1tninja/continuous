import { useCallback } from "react";
import { useAppDispatch } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { type McpDialogMode, McpServerDialog } from "./McpServerDialog";

export interface OpenMcpDialogOptions {
  mode: McpDialogMode;
  /**
   * The control that opened the dialog (the + button, a server's menu
   * button). Focus goes back to it when the dialog closes.
   */
  opener?: HTMLElement | null;
  /** Called after a save, with what was written. */
  onSaved?: (message: string) => void;
}

/** Opens "Add MCP server" or "Edit MCP server" in the app dialog. */
export function useMcpServerDialog() {
  const dispatch = useAppDispatch();

  return useCallback(
    ({ mode, opener, onSaved }: OpenMcpDialogOptions) => {
      const close = () => {
        dispatch(setShowDialog(false));
        dispatch(setDialogMessage(undefined));
        // A menu item that opened the dialog is gone by now; its button is not
        setTimeout(() => {
          if (opener?.isConnected) opener.focus();
        }, 0);
      };
      dispatch(setShowDialog(true));
      dispatch(
        setDialogMessage(
          <McpServerDialog
            mode={mode}
            onDone={(message) => {
              close();
              onSaved?.(message);
            }}
            onCancel={close}
          />,
        ),
      );
    },
    [dispatch],
  );
}
