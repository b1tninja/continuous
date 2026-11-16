import { maskCommandForDisplay } from "core/tools/permissions/displayMask.js";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";

import { ToolCallTitle } from "src/tools/ToolCallTitle.js";

import { generatePolicyRule } from "../../permissions/policyWriter.js";
import { ToolCallPreview } from "../../tools/types.js";
import {
  CONFIRM_TEXT,
  confirmKeyAction,
  useInterruptConfirm,
} from "../hooks/useInterruptConfirm.js";
import { defaultBoxStyles } from "../styles.js";

import { ToolArgsDetail } from "./ToolArgsDetail.js";
import { ToolPreview } from "./ToolPreview.js";

// show dangerous commmand warning only once per CLI process
let hasShownDangerousCommandWarning = false;

interface PermissionOption {
  id: string;
  name: string;
  color: string;
  approved: boolean;
  createPolicy?: boolean;
  stopStream?: boolean;
}

interface ToolPermissionSelectorProps {
  toolName: string;
  toolArgs: any;
  requestId: string;
  toolCallPreview?: ToolCallPreview[];
  hasDynamicEvaluation?: boolean;
  onResponse: (
    requestId: string,
    approved: boolean,
    createPolicy?: boolean,
    stopStream?: boolean,
  ) => void;
}

const getPermissionOptions = (rule: string): PermissionOption[] => {
  return [
    { id: "approve", name: "Continue", color: "green", approved: true },
    {
      id: "approve_policy",
      name: `Continue + always allow ${rule.length > 60 ? `${rule.slice(0, 59)}…` : rule}`,
      color: "cyan",
      approved: true,
      createPolicy: true,
    },
    {
      id: "deny",
      name: "No, skip this call (the agent goes on without it)",
      color: "yellow",
      approved: false,
    },
    {
      id: "deny_stop",
      name: "No, and tell Continue what to do differently (stops the response)",
      color: "yellow",
      approved: false,
      stopStream: true,
    },
  ];
};

export const ToolPermissionSelector: React.FC<ToolPermissionSelectorProps> = ({
  toolName,
  toolArgs,
  requestId,
  toolCallPreview,
  hasDynamicEvaluation = false,
  onResponse,
}) => {
  // Named in full, because it is saved for every later session
  // The rule that is saved is the real one; the line that names it is masked
  const permissionOptions = getPermissionOptions(
    maskCommandForDisplay(generatePolicyRule(toolName, toolArgs)),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [initialHasShownDangerousCommand] = useState(
    hasShownDangerousCommandWarning,
  );
  hasShownDangerousCommandWarning = false;
  const showDynamicWarning =
    hasDynamicEvaluation && !initialHasShownDangerousCommand;

  // Ending the turn asks first (useInterruptConfirm); denying one call does not
  const confirm = useInterruptConfirm(true);
  const respond = (option: PermissionOption) => {
    if (option.stopStream) {
      confirm.open("stop");
      return;
    }
    onResponse(
      requestId,
      option.approved,
      option.createPolicy,
      option.stopStream,
    );
  };

  useInput((input, key) => {
    if (confirm.current()) {
      const action = confirmKeyAction(
        confirm.openedAt.current,
        Date.now(),
        key,
      );
      if (action === "ignore") return;
      confirm.close();
      if (action === "confirm") onResponse(requestId, false, false, true);
      // Esc, or any other key, goes back to the question about the call
      return;
    }

    if (key.return) {
      respond(permissionOptions[selectedIndex]);
      return;
    }

    // Tab to continue (approve)
    if (key.tab && !key.shift) {
      onResponse(requestId, true, false, false);
      return;
    }

    // "a" to continue and always allow; Shift+Tab cycles modes elsewhere
    if (input === "a" && !key.ctrl && !key.meta) {
      onResponse(requestId, true, true, false);
      return;
    }

    // Esc or Ctrl+C denies this call only: the model gets the denied result
    // and the turn goes on. No single key ends the turn.
    if (key.escape || (key.ctrl && input === "c")) {
      onResponse(requestId, false, false, false);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow) {
      setSelectedIndex(
        Math.min(permissionOptions.length - 1, selectedIndex + 1),
      );
    }

    // Also support y/n for quick responses
    if (input === "y" || input === "Y") {
      onResponse(requestId, true, false, false);
    } else if (input === "n" || input === "N") {
      // "No, and tell Continue what to do differently": asks before it stops
      confirm.open("stop");
    }
  });

  return (
    <Box {...defaultBoxStyles("magenta")}>
      <Text color="magenta" bold>
        <ToolCallTitle toolName={toolName} args={toolArgs} />
      </Text>

      {/* Show preview of what the tool will do */}
      <Box>
        <ToolPreview
          toolName={toolName}
          toolArgs={toolArgs}
          toolCallPreview={toolCallPreview}
        />
      </Box>

      <ToolArgsDetail toolArgs={toolArgs} />

      <Box marginTop={1} flexDirection="column">
        {confirm.pending ? (
          <Text color="yellow">{CONFIRM_TEXT[confirm.pending]}</Text>
        ) : (
          <Text color="dim">Would you like to continue?</Text>
        )}
        {showDynamicWarning && (
          <Box marginTop={1}>
            <Text color="yellow" dimColor>
              Note: Dangerous commands will be blocked regardless of your
              preference.
            </Text>
          </Box>
        )}
        {permissionOptions.map((option, index) => {
          const isSelected = index === selectedIndex;
          let shortcut = "";
          if (option.id === "approve") shortcut = "(tab)";
          else if (option.id === "approve_policy") shortcut = "(a)";
          else if (option.id === "deny") shortcut = "(esc)";
          else if (option.id === "deny_stop") shortcut = "(n)";

          return (
            <Box key={option.id} marginTop={index === 0 ? 1 : 0}>
              <Text
                color={isSelected ? option.color : "white"}
                bold={isSelected}
              >
                {isSelected ? "> " : "  "}
                {option.name}
              </Text>
              <Text color="gray" dimColor>
                {" "}
                {shortcut}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
