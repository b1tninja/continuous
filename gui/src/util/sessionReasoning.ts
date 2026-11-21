import type { ModeReasoningEffort } from "core";

/**
 * The session reasoning flag after a config load, and after the Thinking
 * menu changes the mode's effort.
 *
 * `buildChatRequest` uses `modeModels.<use>.reasoningEffort` only while
 * `hasReasoningEnabled` is unset. A stored bulb choice (the person clicked
 * Reasoning) is that flag, and it wins. With no stored choice, a mode effort
 * stays unset so the request sends that effort. With neither, a model that
 * can reason starts on, as the bulb did before.
 */
export function sessionReasoningAfterConfig(input: {
  supportsReasoning: boolean;
  /** `completionOptions.reasoning: false` on the model. */
  reasoningDisabledOnModel: boolean;
  /** Absent when the person has not clicked the bulb for this model. */
  storedToggle: boolean | undefined;
  modeEffort: ModeReasoningEffort | undefined;
}): boolean | undefined {
  if (input.storedToggle !== undefined) {
    return (
      input.supportsReasoning &&
      !input.reasoningDisabledOnModel &&
      input.storedToggle
    );
  }
  if (input.modeEffort) return undefined;
  return input.supportsReasoning && !input.reasoningDisabledOnModel;
}
