import { useStore } from "react-redux";
import { useNavigate } from "react-router-dom";
import { useModelConfigDialog } from "../components/ModelConfig/useModelConfigDialog";
import { useAppDispatch } from "../redux/hooks";
import { selectAgentsSnapshot } from "../redux/selectors/selectAgents";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import { setAgentsPanelFocusRequested } from "../redux/slices/uiSlice";
import type { RootState } from "../redux/store";
import {
  resumeResponseThunk,
  startLoopFromPaletteThunk,
  stopLoopFromPaletteThunk,
  stopResponseThunk,
} from "../redux/thunks/paletteCommands";
import { ROUTES } from "../util/navigation";
import { useWebviewListener } from "./useWebviewListener";

/**
 * The Command Palette's chat actions (NI13), sent by the extension. Each runs
 * what its button runs and answers whether it applied, so the extension can
 * say "nothing to stop" instead of doing nothing. The page commands
 * (Permissions, the audit inbox, Stats) go through `navigateTo`.
 */
export function usePaletteCommandListeners() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const navigate = useNavigate();
  const openModelConfig = useModelConfigDialog();

  useWebviewListener(
    "stopResponse",
    async () => dispatch(stopResponseThunk()).unwrap(),
    [dispatch],
  );

  useWebviewListener(
    "resumeResponse",
    async () => {
      const resumed = await dispatch(resumeResponseThunk()).unwrap();
      if (resumed) void navigate(ROUTES.HOME);
      return resumed;
    },
    [dispatch, navigate],
  );

  useWebviewListener(
    "startLoop",
    async () => {
      void navigate(ROUTES.HOME);
      return dispatch(startLoopFromPaletteThunk()).unwrap();
    },
    [dispatch, navigate],
  );

  useWebviewListener(
    "stopLoop",
    async () => dispatch(stopLoopFromPaletteThunk()).unwrap(),
    [dispatch],
  );

  // The agents panel is on the chat page, above the input
  useWebviewListener(
    "showAgents",
    async () => {
      if (selectAgentsSnapshot(store.getState()).nodes.length === 0) {
        return false;
      }
      void navigate(ROUTES.HOME);
      dispatch(setAgentsPanelFocusRequested(true));
      return true;
    },
    [dispatch, navigate, store],
  );

  // The selected chat model's settings open at Connection, where Test
  // connection is (the gear beside the model in the model picker)
  useWebviewListener(
    "testConnection",
    async () => {
      const model = selectSelectedChatModel(store.getState());
      if (!model) return false;
      openModelConfig(model);
      return true;
    },
    [openModelConfig, store],
  );
}

/** Mounts the listeners; inside AuthProvider, which the model dialog needs. */
export function PaletteCommandListeners() {
  usePaletteCommandListeners();
  return null;
}
