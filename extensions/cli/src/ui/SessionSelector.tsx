import type { Session } from "core/index.js";
import { format, isThisWeek, isThisYear, isToday, isYesterday } from "date-fns";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";

import { ExtendedSessionMetadata, loadSessionById } from "../session.js";

import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { SessionPreview } from "./SessionPreview.js";
import { defaultBoxStyles } from "./styles.js";

interface SessionSelectorProps {
  /**
   * In display order. Sessions carrying `workspaceGroup` (from
   * `orderSessionsForWorkspace`) are shown under a header per folder; the
   * first row is selected at the start, so with that order Enter resumes
   * the newest session of the folder the CLI runs in.
   */
  sessions: ExtendedSessionMetadata[];
  onSelect: (sessionId: string) => void;
  onExit: () => void;
  /** Heading of the list; "Recent Sessions" by default */
  title?: string;
}

/** The header shown above a session's group, or undefined when not grouped. */
function groupHeader(session: ExtendedSessionMetadata): string | undefined {
  if (session.workspaceGroup === undefined) return undefined;
  return session.inWorkspace
    ? `${session.workspaceGroup} (this folder)`
    : session.workspaceGroup;
}

/** Which of `window` start a new group (and so have a header line above them). */
function headerFlags(window: ExtendedSessionMetadata[]): boolean[] {
  return window.map((session, index) => {
    const header = groupHeader(session);
    if (header === undefined) return false;
    return index === 0 || groupHeader(window[index - 1]) !== header;
  });
}

function formatTimestamp(date: Date): string {
  if (isToday(date)) {
    return format(date, "h:mm a");
  } else if (isYesterday(date)) {
    return "yesterday";
  } else if (isThisWeek(date)) {
    return format(date, "EEEE"); // Day name (e.g., "Monday")
  } else if (isThisYear(date)) {
    return format(date, "MMM d"); // e.g., "Jan 15"
  } else {
    return format(date, "MMM d, yyyy"); // e.g., "Jan 15, 2023"
  }
}

function formatMessage(message: string | undefined): string {
  if (!message) return "(no messages)";
  // Ensure we're working with a string, handle edge cases from persisted data
  const messageStr = typeof message === "string" ? message : String(message);
  return messageStr.split("\n")[0];
}

export function SessionSelector({
  sessions,
  onSelect,
  onExit,
  title = "Recent Sessions",
}: SessionSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewSession, setPreviewSession] = useState<Session | null>(null);
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();

  // Load the selected session for preview
  useEffect(() => {
    const selectedSession = sessions[selectedIndex];
    if (selectedSession && !selectedSession.isRemote) {
      const session = loadSessionById(selectedSession.sessionId);
      setPreviewSession(session);
    } else {
      setPreviewSession(null);
    }
  }, [selectedIndex, sessions]);

  // Calculate how many sessions we can display based on terminal height and scrolling
  const { displaySessions, scrollOffset } = useMemo(() => {
    // Account for:
    // - Box border (top + bottom): 2 lines
    // - Box padding (top + bottom): 2 lines
    // - Header "Recent Sessions": 1 line
    // - Instructions line: 1 line
    // - Empty line after instructions: 1 line
    // - Potential scroll indicators: up to 2 lines (1 above, 1 below)
    // Total overhead: ~9 lines
    // - A workspace header: 1 line per group in view
    const MAGIC_NUMBER = 9;
    const availableHeight = Math.max(1, terminalHeight - MAGIC_NUMBER);

    const windowAt = (count: number) => {
      // Calculate scroll offset to keep selected item visible
      let offset = 0;
      if (selectedIndex >= count) {
        offset = Math.min(selectedIndex - count + 1, sessions.length - count);
      }
      return { offset, window: sessions.slice(offset, offset + count) };
    };

    let count = Math.max(1, Math.floor(availableHeight / 3));
    let { offset, window } = windowAt(count);
    // Headers take a line each: show fewer sessions until they fit
    while (
      count > 1 &&
      window.length * 3 + headerFlags(window).filter(Boolean).length >
        availableHeight
    ) {
      count--;
      ({ offset, window } = windowAt(count));
    }
    return { displaySessions: window, scrollOffset: offset };
  }, [sessions, terminalHeight, selectedIndex]);
  const startsGroup = headerFlags(displaySessions);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : sessions.length - 1));
    } else if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      if (sessions[selectedIndex]) {
        onSelect(sessions[selectedIndex].sessionId);
      }
    } else if (key.escape || (key.ctrl && input === "d")) {
      onExit();
    }
  });

  if (sessions.length === 0) {
    return (
      <Box {...defaultBoxStyles("blue")}>
        <Text color="yellow">No previous sessions found.</Text>
        <Text color="gray">Start a new conversation with: cn</Text>
        <Text color="gray">Press Esc to exit</Text>
      </Box>
    );
  }

  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + displaySessions.length < sessions.length;

  // Determine if we should show preview (only if terminal is wide enough)
  const showPreview = terminalWidth > 100;
  const listWidth = showPreview
    ? Math.floor(terminalWidth * 0.3)
    : terminalWidth;

  return (
    <Box flexDirection="row" width={terminalWidth}>
      {/* Left side: Session list */}
      <Box {...defaultBoxStyles("blue")} width={listWidth}>
        <Text color="blue" bold>
          {title}{" "}
          {sessions.length > displaySessions.length &&
            `(${selectedIndex + 1}/${sessions.length})`}
        </Text>
        <Text color="gray">↑/↓ to navigate, Enter to select, Esc to exit</Text>
        <Text> </Text>

        {hasMoreAbove && (
          <Text color="gray" italic>
            ⬆ {scrollOffset} more sessions above...
          </Text>
        )}

        {displaySessions.map((session, index) => {
          const globalIndex = index + scrollOffset;
          const isSelected = globalIndex === selectedIndex;
          const indicator = isSelected ? "➤ " : "  ";
          const color = isSelected ? "blue" : "white";

          const header = startsGroup[index] ? groupHeader(session) : undefined;

          return (
            <Box key={session.sessionId} flexDirection="column">
              {header !== undefined && (
                <Text
                  color={session.inWorkspace ? "green" : "cyan"}
                  bold
                  wrap="truncate-middle"
                >
                  {header}
                </Text>
              )}
              <Box paddingRight={3}>
                <Text bold={isSelected} color={color} wrap="truncate-end">
                  {indicator}
                  {formatMessage(session.title)}
                </Text>
              </Box>
              <Box marginLeft={2}>
                <Text color="gray">
                  {formatTimestamp(
                    new Date(session.lastModified ?? session.dateCreated),
                  )}
                  {session.isRemote ? " (remote)" : " (local)"}
                </Text>
              </Box>
              {index < displaySessions.length - 1 && (
                <Text key={`spacer-${session.sessionId}`}> </Text>
              )}
            </Box>
          );
        })}

        {hasMoreBelow && (
          <Text color="gray" italic>
            ⬇ {sessions.length - scrollOffset - displaySessions.length} more
            sessions below...
          </Text>
        )}
      </Box>

      {/* Right side: Preview panel */}
      {showPreview && (
        <Box marginLeft={1} flexGrow={1} width="100%">
          {previewSession ? (
            <SessionPreview
              chatHistory={previewSession.history}
              sessionTitle={previewSession.title}
            />
          ) : (
            <Box
              {...defaultBoxStyles("blue")}
              flexDirection="column"
              width="100%"
            >
              <Text color="blue" bold>
                Preview
              </Text>
              <Text color="gray">
                {sessions[selectedIndex]?.isRemote
                  ? "(remote session preview not available)"
                  : "(loading...)"}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
