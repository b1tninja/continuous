import { useContext } from "react";
import { useStore } from "react-redux";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import {
  deleteCompaction,
  setCompactionLoading,
  setPreparedCompaction,
} from "../redux/slices/sessionSlice";
import type { RootState } from "../redux/store";
import { usablePreparedCompaction } from "../redux/thunks/prepareCompaction";
import { loadSession, saveCurrentSession } from "../redux/thunks/session";
import { compactionPrefix } from "./compactionPrefix";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);
  const store = useStore<RootState>();

  return async (requestedIndex: number): Promise<boolean> => {
    if (!currentSessionId) {
      return false;
    }

    // Planned compaction: a summary prepared in the background for the
    // current plan is saved as it is, at the plan's boundary, with no request.
    // The newest turns after it stay word for word.
    const prepared = usablePreparedCompaction(store.getState(), requestedIndex);
    const index = prepared?.index ?? requestedIndex;

    try {
      // Set loading state
      dispatch(setCompactionLoading({ index, loading: true }));

      // While the prompt cache is warm, the summary request is the conversation
      // plus the summary prompt, so it reads the cache. Otherwise it is sent
      // as it always was.
      const prefix = prepared
        ? undefined
        : compactionPrefix(store.getState(), index, Date.now());

      const result = await ideMessenger.request("conversation/compact", {
        index,
        sessionId: currentSessionId,
        ...(prefix && { prefix }),
        ...(prepared && { summary: prepared.summary }),
      });
      // request() does not throw: a failure comes back as status "error".
      // Unchecked, a failed compaction reloaded the unchanged session and
      // looked like the button did nothing.
      if (result.status === "error") {
        ideMessenger.post("showToast", [
          "error",
          `Compacting failed, so the conversation was not changed: ${result.error}`,
        ]);
        return false;
      }

      if (prepared) dispatch(setPreparedCompaction(undefined));
      // Reload the current session to refresh the conversation state
      dispatch(
        loadSession({
          sessionId: currentSessionId,
          saveCurrentSession: false,
        }),
      );
      return true;
    } catch (error) {
      console.error("Error compacting conversation:", error);
      ideMessenger.post("showToast", [
        "error",
        `Compacting failed, so the conversation was not changed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
      return false;
    } finally {
      // Clear loading state
      dispatch(setCompactionLoading({ index, loading: false }));
    }
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    // Update local state and save to persistence
    dispatch(deleteCompaction(index));
    dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};
