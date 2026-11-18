import { Box, Text } from "ink";
import React from "react";

import { thoughtForLabel } from "../../stream/reasoning.js";

/** How much of the live reasoning stays on screen: its newest lines. */
const LIVE_LINES = 8;
/** A long paragraph wraps to many rows; its newest characters are kept. */
const LIVE_CHARS = 1200;

/** The newest part of the reasoning, so the view follows the stream. */
export function liveTail(text: string): string {
  const lines = text.trimEnd().split("\n");
  let tail = lines.slice(-LIVE_LINES).join("\n");
  if (tail.length > LIVE_CHARS) {
    tail = "…" + tail.slice(-LIVE_CHARS);
  }
  return tail.trimStart();
}

interface LiveThinkingProps {
  text: string;
}

/** The reasoning while the model thinks: dimmed, newest lines only. */
export const LiveThinking: React.FC<LiveThinkingProps> = ({ text }) => {
  const tail = liveTail(text);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor italic>
        ∴ Thinking…
      </Text>
      {tail && (
        <Box marginLeft={2}>
          <Text dimColor>{tail}</Text>
        </Box>
      )}
    </Box>
  );
};

interface ThoughtLineProps {
  text: string;
  startAt: number;
  endAt?: number;
  expanded: boolean;
}

/**
 * A finished reply's reasoning: one line, "Thought for 4s", and under it the
 * reasoning itself when expanded (`/thinking expanded`).
 */
export const ThoughtLine: React.FC<ThoughtLineProps> = ({
  text,
  startAt,
  endAt,
  expanded,
}) => (
  <Box flexDirection="column" marginBottom={expanded ? 1 : 0}>
    <Text dimColor italic>
      ∴ {thoughtForLabel(startAt, endAt ?? startAt)}
    </Text>
    {expanded && (
      <Box marginLeft={2}>
        <Text dimColor>{text.trim()}</Text>
      </Box>
    )}
  </Box>
);
