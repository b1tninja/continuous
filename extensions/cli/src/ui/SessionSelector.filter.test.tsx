import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { ExtendedSessionMetadata } from "../session.js";

import { filterSessions, SessionSelector } from "./SessionSelector.js";

const DELETE = "\u001b[3~";
const CTRL_U = "\u0015";
const BACKSPACE = "\u007f";
const ESC = "\u001b";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function sessions(): ExtendedSessionMetadata[] {
  const at = new Date().toISOString();
  return [
    {
      sessionId: "a",
      title: "Fix the parser",
      dateCreated: at,
      workspaceDirectory: "/code/proj",
      firstUserMessage: "the TOML parser crashes",
    },
    {
      sessionId: "b",
      title: "Write release notes",
      dateCreated: at,
      workspaceDirectory: "/code/proj",
    },
    {
      sessionId: "c",
      title: "Deploy script",
      dateCreated: at,
      workspaceDirectory: "/code/ops",
    },
  ];
}

describe("filterSessions", () => {
  it("matches every word in the title, first message or folder", () => {
    const all = sessions();
    expect(filterSessions(all, "").map((s) => s.sessionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(filterSessions(all, "toml").map((s) => s.sessionId)).toEqual(["a"]);
    expect(filterSessions(all, "OPS").map((s) => s.sessionId)).toEqual(["c"]);
    expect(filterSessions(all, "release proj").map((s) => s.sessionId)).toEqual(
      ["b"],
    );
    expect(filterSessions(all, "nothing")).toEqual([]);
  });
});

describe("SessionSelector: type to filter", () => {
  it("filters as the person types, Enter picks the first match, Esc clears", async () => {
    const onSelect = vi.fn();
    const onExit = vi.fn();
    const { lastFrame, stdin } = render(
      <SessionSelector
        sessions={sessions()}
        onSelect={onSelect}
        onExit={onExit}
      />,
    );
    expect(lastFrame()).toContain("type to filter");

    stdin.write("dep");
    await tick();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("Filter: dep");
    expect(frame).toContain("Deploy script");
    expect(frame).not.toContain("Fix the parser");

    stdin.write("x");
    await tick();
    expect(lastFrame()).toContain('No session matches "depx"');
    stdin.write(BACKSPACE);
    await tick();
    expect(lastFrame()).toContain("Deploy script");

    stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenCalledWith("c");

    stdin.write(ESC);
    await tick();
    frame = lastFrame() ?? "";
    expect(frame).toContain("Fix the parser");
    expect(onExit).not.toHaveBeenCalled();
    stdin.write(ESC);
    await tick();
    expect(onExit).toHaveBeenCalled();
  });
});

describe("SessionSelector: delete with confirmation", () => {
  it("asks, moves to the trash on y, and Ctrl+U puts it back", async () => {
    const trashSession = vi.fn(async (sessionId: string) => ({
      status: "trashed" as const,
      sessionId,
      deletedAt: 1,
      purgeAfter: 2,
    }));
    const restoreSession = vi.fn();
    const { lastFrame, stdin } = render(
      <SessionSelector
        sessions={sessions()}
        onSelect={vi.fn()}
        onExit={vi.fn()}
        trashSession={trashSession}
        restoreSession={restoreSession}
      />,
    );

    // Anything but y keeps it
    stdin.write(DELETE);
    await tick();
    expect(lastFrame()).toContain('Move "Fix the parser" to the trash? y/n');
    stdin.write("n");
    await tick();
    expect(trashSession).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Not deleted.");
    expect(lastFrame()).toContain("Fix the parser");

    stdin.write(DELETE);
    await tick();
    stdin.write("y");
    await tick();
    expect(trashSession).toHaveBeenCalledWith("a", { force: false });
    let frame = lastFrame() ?? "";
    expect(frame).toContain("to the trash (kept 7 days)");
    expect(frame).not.toContain("➤ Fix the parser");
    expect(frame).toMatch(/➤ Write release notes/);

    stdin.write(CTRL_U);
    await tick();
    expect(restoreSession).toHaveBeenCalledWith("a");
    frame = lastFrame() ?? "";
    expect(frame).toContain('Restored "Fix the parser"');
    expect(frame).toMatch(/➤ Fix the parser/);
  });

  it("deletes the filtered selection, and asks again when it is open elsewhere", async () => {
    const trashSession = vi.fn(
      async (sessionId: string, options: { force?: boolean }) =>
        options.force
          ? {
              status: "trashed" as const,
              sessionId,
              deletedAt: 1,
              purgeAfter: 2,
            }
          : {
              status: "open-elsewhere" as const,
              sessionId,
              pid: 4242,
              host: "here",
              at: 1,
            },
    );
    const { lastFrame, stdin } = render(
      <SessionSelector
        sessions={sessions()}
        onSelect={vi.fn()}
        onExit={vi.fn()}
        trashSession={trashSession}
        restoreSession={vi.fn()}
      />,
    );
    stdin.write("deploy");
    await tick();
    stdin.write(DELETE);
    await tick();
    expect(lastFrame()).toContain('Move "Deploy script" to the trash? y/n');
    stdin.write("y");
    await tick();
    expect(trashSession).toHaveBeenLastCalledWith("c", { force: false });
    expect(lastFrame()).toContain(
      "open in another window or agent (process 4242)",
    );
    stdin.write("y");
    await tick();
    expect(trashSession).toHaveBeenLastCalledWith("c", { force: true });
    expect(lastFrame()).toContain('No session matches "deploy"');
  });

  it("refuses the session the terminal is in", async () => {
    const { lastFrame, stdin } = render(
      <SessionSelector
        sessions={sessions()}
        onSelect={vi.fn()}
        onExit={vi.fn()}
        trashSession={async (sessionId) => ({ status: "current", sessionId })}
        restoreSession={vi.fn()}
      />,
    );
    stdin.write(DELETE);
    await tick();
    stdin.write("y");
    await tick();
    expect(lastFrame()).toContain("it cannot be deleted here");
    expect(lastFrame()).toContain("Fix the parser");
  });
});
