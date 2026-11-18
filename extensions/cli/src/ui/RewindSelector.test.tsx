import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { RewindItem } from "../checkpoints/model.js";
import type { RewindEntry } from "../checkpoints/rewind.js";

import { RewindSelector } from "./RewindSelector.js";

const tick = () => new Promise((r) => setTimeout(r, 30));
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ENTER = "\r";
const ESC = "\u001b";

const entries: RewindEntry[] = [
  {
    number: 1,
    label: "add a parser",
    historyIndex: 0,
    filesTurnId: "t1",
    files: ["/w/a.ts"],
  },
  { number: 2, label: "explain it", historyIndex: 2, files: [] },
  {
    number: 3,
    label: "old compacted prompt",
    filesTurnId: "t3",
    files: ["/w/b.ts"],
  },
];

const item = (uri: string, changedOutside = false): RewindItem => ({
  uri,
  action: "restore",
  snapshot: { uri, existed: true, blob: "x" },
  changedOutside,
  added: 2,
  removed: 1,
});

function setup(
  overrides: Partial<React.ComponentProps<typeof RewindSelector>> = {},
) {
  const props = {
    entries,
    preview: vi.fn((e: RewindEntry) =>
      e.filesTurnId ? [item(e.files[0] ?? "/w/a.ts")] : [],
    ),
    redoPreview: vi.fn(() => undefined as RewindItem[] | undefined),
    onRewind: vi.fn(),
    onRedo: vi.fn(),
    onExit: vi.fn(),
    cwd: "/w",
    ...overrides,
  };
  return { props, ...render(<RewindSelector {...props} />) };
}

describe("RewindSelector", () => {
  it("lists prompts with the files written and states what is not covered", () => {
    const { lastFrame } = setup();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1. add a parser");
    expect(frame).toContain("1 file(s) written");
    expect(frame).toContain("not in the conversation");
    expect(frame).toContain("Files changed by shell commands");
    expect(frame).not.toContain("redo");
  });

  it("selects a prompt and offers files, conversation and both", async () => {
    const { stdin, lastFrame, props } = setup();
    stdin.write(UP);
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Rewind to before: add a parser");
    expect(frame).toContain("a.ts  +2 -1");
    expect(frame).toContain("1. Restore files (keep the conversation)");
    expect(frame).toContain("2. Rewind the conversation (keep the files)");
    expect(frame).toContain("3. Restore files and rewind the conversation");

    stdin.write("3");
    await tick();
    expect(props.onRewind).toHaveBeenCalledWith(entries[0], "both", false);
  });

  it("offers only the conversation when no files were written after the prompt", async () => {
    const { stdin, lastFrame, props } = setup();
    stdin.write(UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Restore files");
    expect(frame).toContain("1. Rewind the conversation");
    stdin.write(ENTER);
    await tick();
    expect(props.onRewind).toHaveBeenCalledWith(
      entries[1],
      "conversation",
      false,
    );
  });

  it("asks before overwriting a file changed outside the agent", async () => {
    const { stdin, lastFrame, props } = setup({
      preview: vi.fn(() => [item("/w/a.ts", true), item("/w/c.ts")]),
    });
    stdin.write(ENTER); // last entry is selected first
    await tick();
    stdin.write("1");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 file(s) changed outside the agent");
    expect(frame).toContain("a.ts  +2 -1  changed outside the agent");
    expect(props.onRewind).not.toHaveBeenCalled();

    stdin.write("s");
    await tick();
    expect(props.onRewind).toHaveBeenCalledWith(entries[2], "files", false);
  });

  it("y confirms the overwrite; Esc cancels back to the list", async () => {
    const { stdin, lastFrame, props } = setup({
      preview: vi.fn(() => [item("/w/a.ts", true)]),
    });
    stdin.write(ENTER);
    await tick();
    stdin.write("1");
    await tick();
    stdin.write(ESC);
    await tick();
    await tick();
    expect(lastFrame()).toContain("Rewind: pick a prompt");
    expect(props.onRewind).not.toHaveBeenCalled();

    stdin.write(ENTER);
    await tick();
    stdin.write("1");
    await tick();
    stdin.write("y");
    await tick();
    expect(props.onRewind).toHaveBeenCalledWith(entries[2], "files", true);
  });

  it("r redoes the last rewind when there is one", async () => {
    const { stdin, lastFrame, props } = setup({
      redoPreview: vi.fn(() => [item("/w/a.ts")]),
    });
    expect(lastFrame()).toContain("r to redo the last rewind");
    stdin.write("r");
    await tick();
    expect(props.onRedo).toHaveBeenCalledWith(false);
  });

  it("Esc closes the list", async () => {
    const { stdin, props } = setup();
    stdin.write(DOWN);
    await tick();
    stdin.write(ESC);
    await tick();
    await tick();
    expect(props.onExit).toHaveBeenCalled();
  });

  it("refuses to act while the agent is working", async () => {
    const { stdin, lastFrame, props } = setup({ busy: true });
    expect(lastFrame()).toContain("The agent is working");
    stdin.write(ENTER);
    await tick();
    expect(props.onRewind).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to rewind", () => {
    const { lastFrame } = setup({ entries: [] });
    expect(lastFrame()).toContain("No prompts to rewind to yet.");
  });
});
