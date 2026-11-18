import { maskArgsForDisplay } from "core/tools/permissions/displayMask.js";
import { Box, Text } from "ink";
import React from "react";

/** A value longer than this is described, not printed: an edit's whole new file is in the diff above. */
const MAX_VALUE_CHARS = 4000;

export function formatArgValue(value: unknown): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > MAX_VALUE_CHARS
    ? `(${text.length} characters, too long to list here; see the preview above)`
    : text;
}

/**
 * Every argument of the call waiting for approval, in full and masked for
 * display, so that a command or URL the preview shortens is still there to
 * read before answering. Display only: the call gets the real arguments.
 */
export const ToolArgsDetail: React.FC<{ toolArgs: unknown }> = ({
  toolArgs,
}) => {
  if (!toolArgs || typeof toolArgs !== "object") return null;
  const entries = Object.entries(maskArgsForDisplay(toolArgs));
  if (entries.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="dim">Exactly what will be run:</Text>
      {entries.map(([key, value]) => (
        <Box key={key} flexDirection="column" paddingLeft={2}>
          <Text color="dim">{key}:</Text>
          <Box paddingLeft={2}>
            <Text>{formatArgValue(value)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
};
