import type { PromptProgress } from "core/index.js";
import { formatPromptProgress } from "core/llm/promptProgressText.js";
import { Box, Text } from "ink";
import React from "react";

import { LoadingAnimation } from "../LoadingAnimation.js";
import { Timer } from "../Timer.js";

/** The spinner text while a reply is held for tool call recovery. */
const READING_REPLY_MESSAGE = "Checking the reply for a tool request...";

/**
 * The spinner text while a reply is awaited: the recovery hold, else how far
 * a local server has read the prompt ("Reading the prompt: 140k of 300k
 * tokens, 120k from the cache, about 40 s left", the IDE's line), else
 * nothing.
 */
function spinnerMessage(
  isReadingReply: boolean,
  promptProgress: PromptProgress | undefined,
): string {
  if (isReadingReply) return READING_REPLY_MESSAGE;
  if (promptProgress) return formatPromptProgress(promptProgress);
  return "";
}

interface ActionStatusProps {
  visible: boolean;
  startTime: number;
  message: string;
  showSpinner?: boolean;
  color?: string;
  loadingColor?: string;
  additionalHint?: string;
}

const ActionStatus: React.FC<ActionStatusProps> = ({
  visible,
  startTime,
  message,
  showSpinner = false,
  color = "dim",
  loadingColor = "green",
  additionalHint,
}) => {
  if (!visible) return null;

  return (
    <Box paddingX={1} flexDirection="row" gap={1}>
      {showSpinner && <LoadingAnimation color={loadingColor} visible={true} />}
      <Text color={color}>{message}</Text>
      <Text color="dim">(</Text>
      <Timer startTime={startTime} />
      <Text color="dim">• esc to interrupt</Text>
      {additionalHint && <Text color="dim">• {additionalHint}</Text>}
      <Text color="dim">)</Text>
    </Box>
  );
};

export { ActionStatus, READING_REPLY_MESSAGE, spinnerMessage };
