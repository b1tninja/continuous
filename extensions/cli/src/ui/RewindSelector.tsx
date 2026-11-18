import { Box, Text, useInput } from "ink";
import React, { useMemo, useState } from "react";

import type { RewindItem } from "../checkpoints/model.js";
import {
  availableModes,
  describeItems,
  MODE_LABELS,
  NOT_COVERED_NOTE,
  type RewindEntry,
  type RewindMode,
} from "../checkpoints/rewind.js";

import { defaultBoxStyles } from "./styles.js";

export interface RewindSelectorProps {
  entries: RewindEntry[];
  /** What restoring files to before this entry would change */
  preview: (entry: RewindEntry) => RewindItem[];
  /** What redo would put back; undefined when there is nothing to redo */
  redoPreview: () => RewindItem[] | undefined;
  onRewind: (
    entry: RewindEntry,
    mode: RewindMode,
    confirmChanged: boolean,
  ) => void;
  onRedo: (confirmChanged: boolean) => void;
  onExit: () => void;
  /** The agent is working: nothing may change under it */
  busy?: boolean;
  cwd?: string;
  /** Rows of the list shown at once */
  pageSize?: number;
}

type Phase =
  | { kind: "list" }
  | { kind: "actions"; entry: RewindEntry; items: RewindItem[] }
  | {
      kind: "confirm";
      items: RewindItem[];
      run: (confirmChanged: boolean) => void;
    };

function Changed({ items, cwd }: { items: RewindItem[]; cwd: string }) {
  const lines = describeItems(items, cwd);
  if (lines.length === 0) {
    return <Text color="gray">No file changes to restore.</Text>;
  }
  return (
    <Box flexDirection="column">
      {lines.slice(0, 12).map((line, i) => (
        <Text key={i} color={items[i].changedOutside ? "yellow" : undefined}>
          {"  "}
          {line}
        </Text>
      ))}
      {lines.length > 12 && (
        <Text color="gray">
          {"  "}… and {lines.length - 12} more
        </Text>
      )}
    </Box>
  );
}

/**
 * `/rewind`: pick a prompt, then restore the files the agent wrote since,
 * rewind the conversation to before it, or both. `r` redoes the last rewind.
 * Keyboard only.
 */
export function RewindSelector({
  entries,
  preview,
  redoPreview,
  onRewind,
  onRedo,
  onExit,
  busy = false,
  cwd = process.cwd(),
  pageSize = 10,
}: RewindSelectorProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [selected, setSelected] = useState(Math.max(0, entries.length - 1));
  const [action, setAction] = useState(0);
  const redoItems = useMemo(() => redoPreview(), [redoPreview]);

  const modes =
    phase.kind === "actions" ? availableModes(phase.entry, phase.items) : [];

  /** Run now, or ask first when a file changed outside the agent. */
  const guarded = (items: RewindItem[], run: (confirm: boolean) => void) => {
    if (items.some((i) => i.changedOutside)) {
      setPhase({ kind: "confirm", items, run });
    } else {
      run(false);
    }
  };

  const choose = (mode: RewindMode) => {
    if (phase.kind !== "actions") return;
    const { entry, items } = phase;
    if (mode === "conversation") {
      onRewind(entry, mode, false);
      return;
    }
    guarded(items, (confirm) => onRewind(entry, mode, confirm));
  };

  useInput((input, key) => {
    if (busy) {
      if (key.escape || input === "q") onExit();
      return;
    }
    if (phase.kind === "list") {
      if (key.escape || input === "q") onExit();
      else if (key.upArrow || input === "k") {
        setSelected((s) => Math.max(0, s - 1));
      } else if (key.downArrow || input === "j") {
        setSelected((s) => Math.min(entries.length - 1, s + 1));
      } else if (key.return && entries[selected]) {
        const entry = entries[selected];
        setAction(0);
        setPhase({ kind: "actions", entry, items: preview(entry) });
      } else if (input === "r" && redoItems) {
        guarded(redoItems, (confirm) => onRedo(confirm));
      }
      return;
    }
    if (phase.kind === "actions") {
      if (key.escape) setPhase({ kind: "list" });
      else if (key.upArrow || input === "k") {
        setAction((a) => Math.max(0, a - 1));
      } else if (key.downArrow || input === "j") {
        setAction((a) => Math.min(modes.length - 1, a + 1));
      } else if (key.return && modes[action]) choose(modes[action]);
      else if (/^[1-3]$/.test(input) && modes[Number(input) - 1]) {
        choose(modes[Number(input) - 1]);
      }
      return;
    }
    // confirm
    if (input === "y") phase.run(true);
    else if (input === "s") phase.run(false);
    else if (key.escape || input === "n") setPhase({ kind: "list" });
  });

  if (busy) {
    return (
      <Box {...defaultBoxStyles("yellow")}>
        <Text>
          The agent is working. Rewind when it has finished, or press Esc.
        </Text>
      </Box>
    );
  }

  if (phase.kind === "confirm") {
    const outside = phase.items.filter((i) => i.changedOutside);
    return (
      <Box {...defaultBoxStyles("yellow")}>
        <Text bold color="yellow">
          {outside.length} file(s) changed outside the agent since its last
          write
        </Text>
        <Text color="gray">
          Restoring overwrites those changes. Lines are what the restore adds
          and removes.
        </Text>
        <Box marginTop={1}>
          <Changed items={outside} cwd={cwd} />
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text bold>y</Text> overwrite them · <Text bold>s</Text> skip them,
            restore the rest · <Text bold>Esc</Text> cancel
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "actions") {
    return (
      <Box {...defaultBoxStyles("blue")}>
        <Text bold>Rewind to before: {phase.entry.label}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Files that a restore changes:</Text>
          <Changed items={phase.items} cwd={cwd} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          {modes.length === 0 && (
            <Text color="gray">
              Nothing to do here: no file changes and the prompt is no longer in
              the conversation.
            </Text>
          )}
          {modes.map((mode, i) => (
            <Text key={mode} color={i === action ? "blue" : undefined}>
              {i === action ? "➤ " : "  "}
              {i + 1}. {MODE_LABELS[mode]}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color="gray">{NOT_COVERED_NOTE}</Text>
        </Box>
        <Text color="gray">↑/↓ or 1-3 to choose · Enter to run · Esc back</Text>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box {...defaultBoxStyles("blue")}>
        <Text>No prompts to rewind to yet.</Text>
        <Text color="gray">{NOT_COVERED_NOTE}</Text>
        <Text color="gray">Esc to close</Text>
      </Box>
    );
  }

  const start = Math.max(
    0,
    Math.min(selected - Math.floor(pageSize / 2), entries.length - pageSize),
  );
  const visible = entries.slice(start, start + pageSize);
  return (
    <Box {...defaultBoxStyles("blue")}>
      <Text bold>Rewind: pick a prompt to go back to before it</Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((entry) => {
          const isSelected = entry.number - 1 === selected;
          const files = entry.files.length;
          return (
            <Text key={entry.number} color={isSelected ? "blue" : undefined}>
              {isSelected ? "➤ " : "  "}
              {String(entry.number).padStart(3)}. {entry.label}
              <Text color="gray">
                {files > 0 ? `  · ${files} file(s) written` : ""}
                {entry.historyIndex === undefined
                  ? "  · not in the conversation"
                  : ""}
              </Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{NOT_COVERED_NOTE}</Text>
        <Text color="gray">
          ↑/↓ to choose · Enter to select
          {redoItems ? " · r to redo the last rewind" : ""} · Esc to close
        </Text>
      </Box>
    </Box>
  );
}
