import { useCallback } from "react";
import { useEditBlock } from "../mainInput/Lump/useEditBlock";
import { useAppDispatch } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { ModelConfigDialog } from "./ModelConfigDialog";

/**
 * Opens "Configure..." for one model in the app dialog. Used by the gear on
 * each model in the model picker and on the Models settings page.
 */
export function useModelConfigDialog() {
  const dispatch = useAppDispatch();
  const editBlock = useEditBlock();

  return useCallback(
    (model: { title: string; sourceFile?: string } | null | undefined) => {
      if (!model) return;
      const close = () => {
        dispatch(setShowDialog(false));
        dispatch(setDialogMessage(undefined));
      };
      dispatch(setShowDialog(true));
      dispatch(
        setDialogMessage(
          <ModelConfigDialog
            title={model.title}
            onDone={close}
            onCancel={close}
            onOpenFile={() => {
              close();
              editBlock(undefined, model.sourceFile);
            }}
          />,
        ),
      );
    },
    [dispatch, editBlock],
  );
}
