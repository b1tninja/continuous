import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";

import { setExitMessageCallback, shouldShowExitMessage } from "../../index.js";
import type { PermissionMode } from "../../permissions/types.js";
import { type ModelInUse, modelInUseLabel } from "../../services/modelInUse.js";
import type { NavigationScreen } from "../context/NavigationContext.js";
import { UpdateNotification } from "../UpdateNotification.js";

import { ContextPercentageDisplay } from "./ContextPercentageDisplay.js";
import { ModeIndicator } from "./ModeIndicator.js";
import { ResponsiveRepoDisplay } from "./ResponsiveRepoDisplay.js";

export interface BottomStatusBarProps {
  currentMode: PermissionMode;
  remoteUrl?: string;
  isRemoteMode: boolean;
  services: any;
  navState: any;
  navigateTo: (screen: NavigationScreen, data?: any) => void;
  closeCurrentScreen: () => void;
  contextPercentage?: number;
  hasImageInClipboard?: boolean;
  isVerboseMode?: boolean;
  totalCost?: number;
}

export const BottomStatusBar: React.FC<BottomStatusBarProps> = ({
  currentMode,
  remoteUrl,
  isRemoteMode,
  services,
  navState: _navState,
  navigateTo: _navigateTo,
  closeCurrentScreen: _closeCurrentScreen,
  contextPercentage,
  hasImageInClipboard,
  isVerboseMode,
  totalCost,
}) => {
  const [_refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    setExitMessageCallback(() => {
      setRefreshTrigger((prev) => prev + 1);
    });
  }, []);

  const showingExitMessage = shouldShowExitMessage();
  // The model and effort the next request goes to (M7), as the model
  // service recorded it at the last switch
  const inUse = services?.model?.inUse as ModelInUse | undefined;

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Box marginLeft={2} flexDirection="row" alignItems="center">
        {currentMode === "normal" && (
          <React.Fragment>
            {hasImageInClipboard ? (
              <Text key="image-paste-hint" color="cyan" wrap="truncate-start">
                Press Ctrl+V to paste image
              </Text>
            ) : showingExitMessage ? (
              <Text key="repo-url" color="dim" wrap="truncate-start">
                {"ctrl+c to exit"}
              </Text>
            ) : (
              <ResponsiveRepoDisplay remoteUrl={remoteUrl} />
            )}
            <Text key="repo-separator"> </Text>
          </React.Fragment>
        )}
        <ModeIndicator />
        {inUse && (
          <React.Fragment>
            <Text key="model-separator" color="dim">
              {" "}
              •{" "}
            </Text>
            <Text key="model-in-use" color="dim" wrap="truncate-end">
              {modelInUseLabel(inUse)}
            </Text>
          </React.Fragment>
        )}
        {contextPercentage !== undefined && contextPercentage > 0 && (
          <React.Fragment>
            <Text key="context-separator" color="dim">
              {" "}
              •{" "}
            </Text>
            <ContextPercentageDisplay percentage={contextPercentage} />
          </React.Fragment>
        )}
        {isVerboseMode && totalCost !== undefined && totalCost > 0 && (
          <React.Fragment>
            <Text key="cost-separator" color="dim">
              {" "}
              •{" "}
            </Text>
            <Text key="cost-display" color="dim">
              Cost: ${totalCost.toFixed(4)}
            </Text>
          </React.Fragment>
        )}
      </Box>
      <Box marginRight={2} marginLeft={2}>
        <UpdateNotification isRemoteMode={isRemoteMode} />
      </Box>
    </Box>
  );
};
