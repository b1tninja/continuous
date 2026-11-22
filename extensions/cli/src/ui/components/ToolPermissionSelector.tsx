import { maskCommandForDisplay } from "core/tools/permissions/displayMask.js";
import { wouldHaveSentence } from "core/tools/permissions/levelText.js";
import { hostAllowRuleFor } from "core/tools/permissions/webHostRules.js";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

import { ToolCallTitle } from "src/tools/ToolCallTitle.js";

import {
  getCountdown,
  headsUpFor,
  keepWaitingFor,
  onCountdown,
} from "../../permissions/askCountdown.js";
import type { AskWhy } from "../../permissions/askWhy.js";
import { generatePolicyRule } from "../../permissions/policyWriter.js";
import { grantWebHostForSession } from "../../permissions/webSession.js";
import { ToolCallPreview } from "../../tools/types.js";
import {
  CONFIRM_TEXT,
  confirmKeyAction,
  useInterruptConfirm,
} from "../hooks/useInterruptConfirm.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { baseBoxStyles, defaultBoxStyles } from "../styles.js";

import { AskWhyLines } from "./AskWhyLines.js";
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
  /** "Allow <host> for this session": a Web session grant (WB45) */
  grantHost?: string;
}

interface ToolPermissionSelectorProps {
  toolName: string;
  toolArgs: any;
  requestId: string;
  toolCallPreview?: ToolCallPreview[];
  hasDynamicEvaluation?: boolean;
  /** Why the call asks and where that was decided (permissions/explainAsk.ts) */
  why?: AskWhy;
  onResponse: (
    requestId: string,
    approved: boolean,
    createPolicy?: boolean,
    stopStream?: boolean,
  ) => void;
}

/** The host a Fetch asks about, for the Web options; undefined for any other tool. */
function fetchHost(toolName: string, toolArgs: any): string | undefined {
  if (toolName !== "Fetch") return undefined;
  const rule = hostAllowRuleFor(toolArgs?.url);
  return rule ? rule.slice("host:".length) : undefined;
}

/**
 * A Fetch asks about a domain (WB45): allow it for this session (a grant),
 * always (a `host:` allow rule in your permissions.yaml), or not.
 */
const getWebOptions = (host: string): PermissionOption[] => [
  {
    id: "approve",
    name: `Allow ${host} for this session`,
    color: "green",
    approved: true,
    grantHost: host,
  },
  {
    id: "approve_policy",
    name: `Always allow ${host}`,
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

/**
 * A heads-up on a call that runs when its window ends: run it now, or do not
 * run it. There is no "always allow": the level already allows the call.
 */
const HEADS_UP_OPTIONS: PermissionOption[] = [
  { id: "approve", name: "Run now", color: "green", approved: true },
  {
    id: "deny",
    name: "Don't run (the agent goes on without it)",
    color: "yellow",
    approved: false,
  },
  {
    id: "deny_stop",
    name: "Don't run, and tell Continue what to do differently (stops the response)",
    color: "yellow",
    approved: false,
    stopStream: true,
  },
];

/** The border and side padding of the prompt's box, in columns. */
const BOX_CHROME_COLUMNS = 2 + 2 * Number(baseBoxStyles.paddingX ?? 0);

/** "7 s", and "1:05" from a minute up. */
function countdownText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const ToolPermissionSelector: React.FC<ToolPermissionSelectorProps> = ({
  toolName,
  toolArgs,
  requestId,
  toolCallPreview,
  hasDynamicEvaluation = false,
  why,
  onResponse,
}) => {
  // Named in full, because it is saved for every later session
  // The rule that is saved is the real one; the line that names it is masked
  const host = fetchHost(toolName, toolArgs);
  const alwaysRule = host
    ? undefined
    : maskCommandForDisplay(generatePolicyRule(toolName, toolArgs));
  // A heads-up: the level ran the call past this, and it runs unless answered
  const [ranPast] = useState(() => headsUpFor(requestId));
  const permissionOptions = ranPast
    ? HEADS_UP_OPTIONS
    : host
      ? getWebOptions(host)
      : getPermissionOptions(alwaysRule ?? "");
  // r opens the whole reason and the rule that would allow the call
  const [showDetail, setShowDetail] = useState(false);
  const { columns } = useTerminalSize();
  const textWidth = Math.max(20, columns - BOX_CHROME_COLUMNS);
  // A warning the engine put in the preview is the reason: it is shown once,
  // on the Why line, and whole, since it is there to be read before answering
  const isReason = (p: ToolCallPreview) => !!why && p.content === why.reason;
  const reasonIsWarning = !!toolCallPreview?.some(isReason);
  const preview = toolCallPreview?.filter((p) => !isReason(p));
  // Enter passes the option as it is; the shortcuts pass booleans, as before
  const choose = (option: PermissionOption, asSelected = false) => {
    if (option.grantHost) grantWebHostForSession(option.grantHost);
    onResponse(
      requestId,
      option.approved,
      asSelected ? option.createPolicy : !!option.createPolicy,
      asSelected ? option.stopStream : !!option.stopStream,
    );
  };
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The decision timer (askCountdown.ts): seconds until the ask is refused
  const [countdown, setCountdown] = useState(() => getCountdown(requestId));
  useEffect(
    () =>
      onCountdown((id) => {
        if (id === requestId) setCountdown(getCountdown(requestId));
      }),
    [requestId],
  );
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
    choose(option, true);
  };
  const denyOption =
    permissionOptions.find((o) => o.id === "deny") ?? permissionOptions[2];
  const alwaysOption = permissionOptions.find((o) => o.id === "approve_policy");

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

    // w stops the countdown: the call waits for an answer, as it does with no timer
    if (input === "w" && !key.ctrl && !key.meta && countdown) {
      keepWaitingFor(requestId);
      setCountdown(undefined);
      return;
    }

    // r shows or hides the detail; it answers nothing
    if (input === "r" && !key.ctrl && !key.meta && why) {
      setShowDetail((shown) => !shown);
      return;
    }

    // Tab to continue (approve; for a Fetch, for this session)
    if (key.tab && !key.shift) {
      choose(permissionOptions[0]);
      return;
    }

    // "a" to continue and always allow; Shift+Tab cycles modes elsewhere
    if (input === "a" && !key.ctrl && !key.meta) {
      // A heads-up has no "always allow"
      if (alwaysOption) choose(alwaysOption);
      return;
    }

    // Esc or Ctrl+C denies this call only: the model gets the denied result
    // and the turn goes on. No single key ends the turn.
    if (key.escape || (key.ctrl && input === "c")) {
      choose(denyOption);
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
      choose(permissionOptions[0]);
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
          toolCallPreview={preview}
        />
      </Box>

      <ToolArgsDetail toolArgs={toolArgs} />

      <Box marginTop={1} flexDirection="column">
        {why && (
          <AskWhyLines
            why={why}
            width={textWidth}
            full={showDetail}
            wholeReason={reasonIsWarning}
            alwaysRule={alwaysRule}
          />
        )}
        {confirm.pending ? (
          <Text color="yellow">{CONFIRM_TEXT[confirm.pending]}</Text>
        ) : (
          <Text color="dim">
            {ranPast
              ? "This call runs by itself. Stop it here if you want to."
              : "Would you like to continue?"}
            {why &&
              (showDetail
                ? " (r: hide the detail)"
                : " (r: full reason, and a rule to allow this)")}
          </Text>
        )}
        {countdown && (
          <Text color="yellow">
            {countdown.proposed === "refuse" ? "Refused in " : "Runs in "}
            {countdownText(countdown.secondsLeft)} unless you answer. Press w to
            keep waiting.
          </Text>
        )}
        {ranPast && <Text color="yellow">{wouldHaveSentence(ranPast)}</Text>}
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
