import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import { ChatDescriber } from "core/util/chatDescriber.js";

import { updateSessionTitle } from "../session.js";
import { logger } from "../util/logger.js";

/** Names the session after the model's first reply; never fails the reply. */
export async function handleTitleGeneration(
  assistantResponse: string,
  llmApi: BaseLlmApi,
  model: ModelConfig,
): Promise<void> {
  try {
    if (!assistantResponse) return;

    const generatedTitle = await ChatDescriber.describeWithBaseLlmApi(
      llmApi,
      model,
      assistantResponse,
    );

    if (generatedTitle) {
      updateSessionTitle(generatedTitle);
      logger.debug("Generated session title:", generatedTitle);
    }
  } catch (error) {
    // Don't fail the response if title generation fails
    logger.debug("Session title generation failed:", error);
  }
}
