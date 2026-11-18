import type { Middleware } from "@reduxjs/toolkit";
import { noteStreamStop, noteToolFailure } from "../util/chatDebugLog";
import { errorToolCall, setInactive } from "./slices/sessionSlice";

function toolName(
  history: readonly {
    toolCallStates?: readonly {
      toolCallId: string;
      toolCall?: { function?: { name?: string } };
    }[];
  }[],
  id: string,
): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const found = history[i].toolCallStates?.find(
      (call) => call.toolCallId === id,
    );
    if (found) return found.toolCall?.function?.name || id;
  }
  return id;
}

/**
 * Records tool failures and empty stream stops from actions that already
 * exist. It does not change those actions or the session history.
 */
export const chatDebugMiddleware: Middleware = (api) => (next) => (action) => {
  const result = next(action);
  const history = api.getState().session.history;
  if (setInactive.match(action)) {
    noteStreamStop(history);
  } else if (errorToolCall.match(action)) {
    const output = action.payload.output?.[0];
    noteToolFailure(
      toolName(history, action.payload.toolCallId),
      output?.description || output?.content,
    );
  }
  return result;
};
