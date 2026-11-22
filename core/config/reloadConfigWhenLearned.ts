import { onLearned } from "../llm/learnedLimits";

/**
 * When a model's own server says which window it runs the model with (Ollama
 * after the first request, an OpenAI-compatible server's model list), the
 * model objects in the loaded config still hold what they were built with,
 * and so does the GUI. Reloading builds them again with the learned window
 * and sends the GUI the new descriptions, so the model row and the context
 * meter show the window in use without waiting for an unrelated reload.
 * Returns the unsubscribe.
 */
export function reloadConfigWhenLearned(configHandler: {
  reloadConfig(reason: string): Promise<unknown>;
}): () => void {
  return onLearned(() => {
    // advisory: on a failed reload the next one shows the window
    void configHandler.reloadConfig("Context window learned").catch(() => {});
  });
}
