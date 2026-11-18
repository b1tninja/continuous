import type { ChatHistoryItem } from "core/index.js";
import React, { useCallback, useMemo } from "react";

import {
  applyRedo,
  applyRewind,
  buildRewindEntries,
  previewFiles,
  type RewindOutcome,
} from "../checkpoints/rewind.js";
import { checkpointStoreFor } from "../checkpoints/sessionCheckpoints.js";
import type { CheckpointStore } from "../checkpoints/store.js";
import { getCurrentSession } from "../session.js";
import { logger } from "../util/logger.js";

import { RewindSelector } from "./RewindSelector.js";

interface RewindScreenProps {
  chatHistory: ChatHistoryItem[];
  /** Replace the conversation (rewind or redo of the conversation) */
  onHistory: (history: ChatHistoryItem[]) => void;
  /** Close the picker and say what happened */
  onDone: (summary: string) => void;
  onExit: () => void;
  busy?: boolean;
  /** Tests pass a store in a temp folder */
  store?: CheckpointStore;
}

/** The `/rewind` picker bound to the current session's checkpoints. */
export function RewindScreen({
  chatHistory,
  onHistory,
  onDone,
  onExit,
  busy,
  store: givenStore,
}: RewindScreenProps) {
  const store = useMemo(
    () => givenStore ?? checkpointStoreFor(getCurrentSession().sessionId),
    [givenStore],
  );
  const entries = useMemo(
    () => buildRewindEntries(chatHistory, store.turns()),
    [chatHistory, store],
  );
  const redoPreview = useCallback(
    () => (store.redoRecord() ? store.planRedo() : undefined),
    [store],
  );

  const finish = (outcome: RewindOutcome | undefined) => {
    if (!outcome) {
      onDone("Nothing to redo.");
      return;
    }
    if (outcome.history) onHistory(outcome.history);
    logger.info("Rewind", { lines: outcome.lines });
    onDone(outcome.lines.join(" "));
  };

  return (
    <RewindSelector
      entries={entries}
      preview={(entry) => previewFiles(store, entry)}
      redoPreview={redoPreview}
      busy={busy}
      onRewind={(entry, mode, confirmChanged) => {
        try {
          finish(
            applyRewind(store, chatHistory, entry, mode, { confirmChanged }),
          );
        } catch (error) {
          onDone(`Rewind failed: ${(error as Error).message}`);
        }
      }}
      onRedo={(confirmChanged) => {
        try {
          finish(applyRedo(store, chatHistory, { confirmChanged }));
        } catch (error) {
          onDone(`Redo failed: ${(error as Error).message}`);
        }
      }}
      onExit={onExit}
    />
  );
}
