import type { Session } from "core/index.js";
import { format, isThisWeek, isThisYear, isToday, isYesterday } from "date-fns";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";

import {
  ExtendedSessionMetadata,
  loadSessionById,
  type PickerTrashResult,
  restoreTrashedSessionById,
  trashSessionById,
} from "../session.js";

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
  /** Moves a session to the trash; `trashSessionById` by default (tests pass their own) */
  trashSession?: (
    sessionId: string,
    options: { force?: boolean },
  ) => Promise<PickerTrashResult>;
  /** Undo of the last delete; `restoreTrashedSessionById` by default */
  restoreSession?: (sessionId: string) => void;
}

/**
 * Sessions whose title, first message or folder holds every word of
 * `filter` (case does not matter), in the order given.
 */
export function filterSessions(
  sessions: ExtendedSessionMetadata[],
  filter: string,
): ExtendedSessionMetadata[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sessions;
  return sessions.filter((session) => {
    const text = [
      session.title,
      session.firstUserMessage,
      session.workspaceGroup,
      session.workspaceDirectory,
    ]
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** A key that types text into the filter (not a control or navigation key). */
function isTyping(input: string, key: { ctrl: boolean; meta: boolean }) {
  return !!input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input);
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
  sessions: givenSessions,
  onSelect,
  onExit,
  title = "Recent Sessions",
  trashSession = trashSessionById,
  restoreSession = restoreTrashedSessionById,
}: SessionSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewSession, setPreviewSession] = useState<Session | null>(null);
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();
  // Type to filter; Del (or Ctrl+X) asks, then y moves the session to the
  // trash (NI11), and Ctrl+U puts the last one back
  const [all, setAll] = useState(givenSessions);
  useEffect(() => setAll(givenSessions), [givenSessions]);
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<{
    session: ExtendedSessionMetadata;
    openIn?: number;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastTrashed, setLastTrashed] = useState<{
    session: ExtendedSessionMetadata;
    index: number;
  } | null>(null);
  const sessions = useMemo(() => filterSessions(all, filter), [all, filter]);
  useEffect(() => {
    // Keep the selection on a row that is there
    if (selectedIndex >= sessions.length && sessions.length > 0) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

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
    // - Filter line (where an empty line was): 1 line
    // - Potential scroll indicators: up to 2 lines (1 above, 1 below)
    // Total overhead: ~9 lines
    // - A status line (a question or what was done), while shown: 1 line
    // - A workspace header: 1 line per group in view
    const MAGIC_NUMBER = 9 + (confirm || status ? 1 : 0);
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
  }, [sessions, terminalHeight, selectedIndex, confirm, status]);
  const startsGroup = headerFlags(displaySessions);

  const runTrash = async (
    session: ExtendedSessionMetadata,
    force: boolean,
  ): Promise<void> => {
    let result: PickerTrashResult;
    try {
      result = await trashSession(session.sessionId, { force });
    } catch (error) {
      setStatus(
        `Not deleted: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (result.status === "current") {
      setStatus("This is the session you are in; it cannot be deleted here.");
      return;
    }
    if (result.status === "open-elsewhere") {
      setConfirm({ session, openIn: result.pid });
      return;
    }
    const index = all.findIndex((s) => s.sessionId === session.sessionId);
    setAll((list) => list.filter((s) => s.sessionId !== session.sessionId));
    setLastTrashed({ session, index });
    setStatus(
      `Moved "${formatMessage(session.title)}" to the trash (kept 7 days). Ctrl+U puts it back.`,
    );
  };

  const undoTrash = () => {
    if (!lastTrashed) return;
    const { session, index } = lastTrashed;
    try {
      restoreSession(session.sessionId);
    } catch (error) {
      setStatus(
        `Not restored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    setAll((list) => {
      const next = [...list];
      next.splice(Math.min(index, next.length), 0, session);
      return next;
    });
    setLastTrashed(null);
    setStatus(`Restored "${formatMessage(session.title)}".`);
  };

  useInput((input, key) => {
    if (confirm) {
      if (input === "y" || input === "Y") {
        const { session, openIn } = confirm;
        setConfirm(null);
        void runTrash(session, openIn !== undefined);
      } else {
        setConfirm(null);
        setStatus("Not deleted.");
      }
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : sessions.length - 1));
    } else if (key.downArrow || (key.ctrl && input === "n")) {
      setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      if (sessions[selectedIndex]) {
        onSelect(sessions[selectedIndex].sessionId);
      }
    } else if (key.escape) {
      if (filter) {
        setFilter("");
        setSelectedIndex(0);
      } else {
        onExit();
      }
    } else if (key.ctrl && input === "d") {
      onExit();
    } else if (key.delete || (key.ctrl && input === "x")) {
      const session = sessions[selectedIndex];
      if (session && !session.isRemote) {
        setStatus(null);
        setConfirm({ session });
      }
    } else if (key.ctrl && input === "u") {
      undoTrash();
    } else if (key.backspace) {
      setFilter((f) => f.slice(0, -1));
      setSelectedIndex(0);
    } else if (isTyping(input, key)) {
      setFilter((f) => f + input);
      setSelectedIndex(0);
    }
  });

  const statusLine = confirm ? (
    <Text color="yellow" wrap="truncate-end">
      {confirm.openIn === undefined
        ? `Move "${formatMessage(confirm.session.title)}" to the trash? y/n`
        : `It is open in another window or agent (process ${confirm.openIn}). Move it to the trash anyway? y/n`}
    </Text>
  ) : status ? (
    <Text color="gray" wrap="truncate-end">
      {status}
    </Text>
  ) : null;

  if (all.length === 0) {
    return (
      <Box {...defaultBoxStyles("blue")}>
        <Text color="yellow">No previous sessions found.</Text>
        <Text color="gray">Start a new conversation with: cn</Text>
        <Text color="gray">Press Esc to exit</Text>
        {statusLine}
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
        <Text color="gray" wrap="truncate-end">
          ↑/↓ move, Enter select, type to filter, Del delete, Esc{" "}
          {filter ? "clear" : "exit"}
        </Text>
        <Text color={filter ? "white" : "gray"} wrap="truncate-end">
          Filter: {filter || "(type to filter)"}
        </Text>
        {statusLine}

        {sessions.length === 0 && (
          <Text color="yellow" wrap="truncate-end">
            No session matches &quot;{filter}&quot;.
          </Text>
        )}

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
