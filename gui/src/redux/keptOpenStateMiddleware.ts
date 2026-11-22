import type { Middleware } from "@reduxjs/toolkit";
import { clearKeptOpenState } from "../hooks/useKeptOpenState";

/**
 * What the person opened or closed in the conversation belongs to that
 * session. When another session takes the screen (new, loaded or restored)
 * it is dropped, so it never holds more than one conversation's choices.
 */
export const keptOpenStateMiddleware: Middleware = (api) => (next) => {
  let sessionId: string | undefined = api.getState()?.session?.id;
  return (action) => {
    const result = next(action);
    const nextId: string | undefined = api.getState()?.session?.id;
    if (nextId !== sessionId) {
      sessionId = nextId;
      clearKeptOpenState();
    }
    return result;
  };
};
