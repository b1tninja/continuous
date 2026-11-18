import fs from "fs";
import os from "os";
import path from "path";

import type { ChatHistoryItem } from "core/index.js";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { promptHash } from "../checkpoints/model.js";
import { CheckpointStore } from "../checkpoints/store.js";

import { RewindScreen } from "./RewindScreen.js";

const tick = () => new Promise((r) => setTimeout(r, 30));

// The picker on a real store in a temp folder: no model, no session files.
describe("RewindScreen", () => {
  let tmp: string;
  let file: string;
  let store: CheckpointStore;
  const history: ChatHistoryItem[] = [
    { message: { role: "user", content: "change a" }, contextItems: [] },
    { message: { role: "assistant", content: "done" }, contextItems: [] },
  ];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cn-rewind-screen-"));
    file = path.join(tmp, "a.txt");
    fs.writeFileSync(file, "before\n");
    store = new CheckpointStore(path.join(tmp, "checkpoints"), "s1");
    store.snapshotBefore(file, {
      label: "change a",
      promptHash: promptHash("change a"),
      userIndex: 0,
    });
    fs.writeFileSync(file, "after\n");
    store.recordWrite(file, "after\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("restores files and rewinds the conversation, then redo puts both back", async () => {
    const onHistory = vi.fn();
    const onDone = vi.fn();
    const first = render(
      <RewindScreen
        chatHistory={history}
        store={store}
        onHistory={onHistory}
        onDone={onDone}
        onExit={vi.fn()}
      />,
    );
    expect(first.lastFrame()).toContain("change a");
    first.stdin.write("\r");
    await tick();
    first.stdin.write("3");
    await tick();
    expect(fs.readFileSync(file, "utf-8")).toBe("before\n");
    expect(onHistory).toHaveBeenCalledWith([]);
    expect(onDone.mock.calls[0][0]).toMatch(/Restored 1 file/);
    first.unmount();

    const onHistory2 = vi.fn();
    const second = render(
      <RewindScreen
        chatHistory={[]}
        store={store}
        onHistory={onHistory2}
        onDone={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    second.stdin.write("r");
    await tick();
    expect(fs.readFileSync(file, "utf-8")).toBe("after\n");
    expect(onHistory2).toHaveBeenCalledWith(history);
  });
});
