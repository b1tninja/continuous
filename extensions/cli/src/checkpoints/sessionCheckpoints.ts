/**
 * Glue between the checkpoint store and the running session: which store,
 * which turn, and the two calls the file tools make around a write. Neither
 * call ever throws or blocks the tool: a checkpoint that cannot be taken is
 * logged and the write goes ahead.
 */
import fs from "fs";
import path from "path";

import type { ChatHistoryItem } from "core/index.js";
import { getSessionFilePath } from "core/util/paths.js";

import { env } from "../env.js";
import { services } from "../services/index.js";
import { getCurrentSession } from "../session.js";
import { logger } from "../util/logger.js";

import { messageText, promptHash, promptLabel, type TurnRef } from "./model.js";
import { pruneOrphanedCheckpoints } from "./prune.js";
import { CheckpointStore } from "./store.js";

/** `CONTINUOUS_CHECKPOINTS=off` turns snapshots off for the process. */
export function checkpointsEnabled(): boolean {
  const v = process.env.CONTINUOUS_CHECKPOINTS?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

export function checkpointsRoot(): string {
  return path.join(env.continueHome, "checkpoints");
}

let cached: CheckpointStore | undefined;
let prunedOnce = false;

export function checkpointStoreFor(sessionId: string): CheckpointStore {
  if (cached?.sessionId !== sessionId) {
    cached = new CheckpointStore(checkpointsRoot(), sessionId);
  }
  if (!prunedOnce) {
    prunedOnce = true;
    // Sessions removed by delete or `continuous clean` take their
    // checkpoints with them, once per process. Test runs keep sessions
    // elsewhere, so they never prune.
    if (!process.env.CONTINUE_CLI_TEST) {
      try {
        pruneOrphanedCheckpoints(checkpointsRoot(), (id) =>
          fs.existsSync(getSessionFilePath(id)),
        );
      } catch (error) {
        logger.debug("Checkpoint pruning failed", { error });
      }
    }
  }
  return cached;
}

/** The turn a write belongs to: the last user message in the history. */
export function turnRefFromHistory(history: ChatHistoryItem[]): TurnRef {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i].message;
    if (message.role === "user") {
      const text = messageText(message.content);
      return {
        label: promptLabel(text) || "(empty prompt)",
        promptHash: promptHash(text),
        userIndex: i,
      };
    }
  }
  return { label: "(no prompt)", promptHash: promptHash(""), userIndex: -1 };
}

function currentHistory(): ChatHistoryItem[] {
  try {
    if (services.chatHistory?.isReady?.()) {
      return services.chatHistory.getHistory();
    }
  } catch {
    // fall back to the session
  }
  return getCurrentSession().history;
}

function keyFor(file: string): string {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Before the agent writes `file`. Never throws. */
export function checkpointBeforeWrite(file: string): void {
  if (!checkpointsEnabled()) return;
  try {
    const store = checkpointStoreFor(getCurrentSession().sessionId);
    store.snapshotBefore(keyFor(file), turnRefFromHistory(currentHistory()));
  } catch (error) {
    logger.warn(`Checkpoint not taken for ${file}`, { error });
  }
}

/** After the agent wrote `content` to `file`. Never throws. */
export function checkpointAfterWrite(file: string, content: string): void {
  if (!checkpointsEnabled()) return;
  try {
    const store = checkpointStoreFor(getCurrentSession().sessionId);
    store.recordWrite(keyFor(file), content);
  } catch (error) {
    logger.warn(`Checkpoint write not recorded for ${file}`, { error });
  }
}
