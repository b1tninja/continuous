import { Text } from "ink";
import React, { useMemo } from "react";

import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { formatRepoText, getRepoInfo } from "../hooks/useTUIChatHooks.js";

interface ResponsiveRepoDisplayProps {
  remoteUrl?: string;
  reservedWidth?: number; // Width reserved for other elements in the same row
}

export const ResponsiveRepoDisplay: React.FC<ResponsiveRepoDisplayProps> = ({
  remoteUrl,
}) => {
  const { columns } = useTerminalSize();

  // Up to three blocking git processes, so read once rather than on every
  // resize step: dragging a terminal edge used to run them for each column.
  const repoInfo = useMemo(() => getRepoInfo(remoteUrl), [remoteUrl]);

  const repoText = useMemo(() => {
    // Calculate available width for repo display
    // Reserve space for margins, mode indicator, context percentage, and other UI elements
    const availableWidth = Math.floor(columns / 2);

    return formatRepoText(repoInfo, availableWidth);
  }, [repoInfo, columns]);

  // Don't render if no text to show
  if (!repoText) {
    return null;
  }

  return (
    <Text color="dim" wrap="truncate-start">
      {repoText}
    </Text>
  );
};
