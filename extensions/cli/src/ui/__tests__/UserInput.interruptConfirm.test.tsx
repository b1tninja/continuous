import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messageQueue } from "../../stream/messageQueue.js";
import { gracefulExit } from "../../util/exit.js";
import {
  CONFIRM_ARM_MS,
  confirmKeyAction,
} from "../hooks/useInterruptConfirm.js";
import { UserInput } from "../UserInput.js";

/*
 * No single key stops a running turn or throws away typed text (NI8 in the
 * terminal): Esc or Ctrl+C asks, Enter answers yes, and the opening key
 * pressed again or held never does.
 */

vi.mock("../../util/exit.js", () => ({ gracefulExit: vi.fn() }));

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_C = "\u0003";
const UP = "\x1b[A";

// ink holds a lone ESC for ~20ms to tell it from an escape sequence
async function press(stdin: { write: (data: string) => void }, data: string) {
  stdin.write(data);
  await vi.advanceTimersByTimeAsync(30);
}

function renderInput(props: Partial<React.ComponentProps<typeof UserInput>>) {
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn();
  const result = render(
    React.createElement(UserInput, {
      onSubmit,
      isWaitingForResponse: false,
      inputMode: true,
      onInterrupt,
      ...props,
    }),
  );
  return { onSubmit, onInterrupt, ...result };
}

describe("confirmKeyAction", () => {
  it("Enter answers yes once armed, Esc no, anything else passes through", () => {
    expect(confirmKeyAction(0, CONFIRM_ARM_MS, { return: true })).toBe(
      "confirm",
    );
    expect(confirmKeyAction(0, CONFIRM_ARM_MS - 1, { return: true })).toBe(
      "ignore",
    );
    expect(
      confirmKeyAction(0, CONFIRM_ARM_MS, { return: true, shift: true }),
    ).toBe("ignore");
    expect(confirmKeyAction(0, 0, { escape: true })).toBe("cancel");
    expect(confirmKeyAction(0, CONFIRM_ARM_MS, {})).toBe("pass");
    expect(confirmKeyAction(0, CONFIRM_ARM_MS, { ctrl: true })).toBe("pass");
  });
});

describe("UserInput asks before stopping or clearing", () => {
  beforeEach(() => {
    messageQueue.clear();
    messageQueue.resume();
    vi.useFakeTimers();
    // Ctrl+C also signals the process for the two-stage exit
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(gracefulExit).mockClear();
  });

  afterEach(() => {
    messageQueue.clear();
    messageQueue.resume();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Esc while the agent works asks and does not interrupt", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      await press(stdin, ESC);
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("Stop the response?");
      expect(lastFrame()).toContain("enter to stop");
    } finally {
      unmount();
    }
  });

  it("Esc again keeps it going, and Esc held never interrupts", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      for (let i = 0; i < 7; i++) {
        await press(stdin, ESC);
      }
      expect(onInterrupt).not.toHaveBeenCalled();
      // Seven presses: open, close, ... open
      expect(lastFrame()).toContain("Stop the response?");
      await press(stdin, ESC);
      expect(lastFrame()).not.toContain("Stop the response?");
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it("Enter right after the question opened does not answer it", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      await press(stdin, ESC);
      await press(stdin, ENTER);
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("Stop the response?");
    } finally {
      unmount();
    }
  });

  it("Enter stops, and keeps what was typed", async () => {
    const { onInterrupt, onSubmit, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      await press(stdin, "half a thought");
      await press(stdin, ESC);
      await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
      await press(stdin, ENTER);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(messageQueue.getQueueLength()).toBe(0);
      expect(lastFrame()).toContain("half a thought");
      expect(lastFrame()).not.toContain("Stop the response?");
    } finally {
      unmount();
    }
  });

  it("another key closes the question and is typed as usual", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      await press(stdin, ESC);
      await press(stdin, "x");
      expect(lastFrame()).not.toContain("Stop the response?");
      expect(lastFrame()).toContain("x");
      await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
      await press(stdin, ENTER);
      // Enter now queues the typed text; nothing was stopped
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it("Ctrl+C on an empty prompt while the agent works asks to stop", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      await press(stdin, CTRL_C);
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("Stop the response?");
      await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
      await press(stdin, ENTER);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it("Ctrl+C with text typed does not clear it until Enter, and Up brings it back", async () => {
    const { stdin, lastFrame, unmount } = renderInput({});
    try {
      await press(stdin, "a long careful prompt");
      await press(stdin, CTRL_C);
      expect(lastFrame()).toContain("a long careful prompt");
      expect(lastFrame()).toContain("Clear the input?");

      // Esc keeps it
      await press(stdin, ESC);
      expect(lastFrame()).toContain("a long careful prompt");
      expect(lastFrame()).not.toContain("Clear the input?");

      await press(stdin, CTRL_C);
      await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
      await press(stdin, ENTER);
      expect(lastFrame()).not.toContain("a long careful prompt");

      await press(stdin, UP);
      expect(lastFrame()).toContain("a long careful prompt");
    } finally {
      unmount();
    }
  });

  it("Ctrl+C on an empty idle prompt asks nothing (the exit hint is the TUI's)", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({});
    try {
      await press(stdin, CTRL_C);
      expect(lastFrame()).not.toContain("Stop the response?");
      expect(lastFrame()).not.toContain("Clear the input?");
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(process.kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    } finally {
      unmount();
    }
  });

  it("a double Ctrl+C while the agent works asks to exit instead of exiting", async () => {
    const { onInterrupt, stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      await press(stdin, CTRL_C);
      await vi.advanceTimersByTimeAsync(200);
      await press(stdin, CTRL_C);
      expect(lastFrame()).toContain("Exit and stop the agent?");
      // Neither press reached the process's two-stage exit
      expect(process.kill).not.toHaveBeenCalled();
      expect(gracefulExit).not.toHaveBeenCalled();

      // Esc stays
      await press(stdin, ESC);
      expect(lastFrame()).not.toContain("Exit and stop the agent?");
      expect(gracefulExit).not.toHaveBeenCalled();

      // Asked again, Enter exits, stopping the turn first
      await vi.advanceTimersByTimeAsync(2000);
      await press(stdin, CTRL_C);
      await vi.advanceTimersByTimeAsync(200);
      await press(stdin, CTRL_C);
      await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
      await press(stdin, ENTER);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(gracefulExit).toHaveBeenCalledWith(0);
    } finally {
      unmount();
    }
  });

  it("a held Ctrl+C (auto-repeat) is never the second press", async () => {
    const { stdin, lastFrame, unmount } = renderInput({
      isWaitingForResponse: true,
    });
    try {
      for (let i = 0; i < 8; i++) {
        stdin.write(CTRL_C);
        await vi.advanceTimersByTimeAsync(30);
      }
      expect(lastFrame()).not.toContain("Exit and stop the agent?");
      expect(gracefulExit).not.toHaveBeenCalled();
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it("idle, a double Ctrl+C still goes to the two-stage exit", async () => {
    const { stdin, lastFrame, unmount } = renderInput({});
    try {
      await press(stdin, CTRL_C);
      await vi.advanceTimersByTimeAsync(200);
      await press(stdin, CTRL_C);
      expect(process.kill).toHaveBeenCalledTimes(2);
      expect(lastFrame()).not.toContain("Exit and stop the agent?");
    } finally {
      unmount();
    }
  });

  it("Ctrl+D asks while the agent works or text is typed, and exits at once otherwise", async () => {
    const working = renderInput({ isWaitingForResponse: true });
    try {
      await press(working.stdin, "\u0004");
      expect(working.lastFrame()).toContain("Exit and stop the agent?");
      expect(gracefulExit).not.toHaveBeenCalled();
    } finally {
      working.unmount();
    }
    const typed = renderInput({});
    try {
      await press(typed.stdin, "my draft");
      await press(typed.stdin, "\u0004");
      expect(typed.lastFrame()).toContain("Exit and stop the agent?");
      expect(typed.lastFrame()).toContain("my draft");
      expect(gracefulExit).not.toHaveBeenCalled();
    } finally {
      typed.unmount();
    }
    const idle = renderInput({});
    try {
      await press(idle.stdin, "\u0004");
      await vi.advanceTimersByTimeAsync(10);
      expect(gracefulExit).toHaveBeenCalledWith(0);
    } finally {
      idle.unmount();
    }
  });

  it("the stop question closes when the turn ends meanwhile", async () => {
    const props = {
      onSubmit: vi.fn(),
      onInterrupt: vi.fn(),
      inputMode: true,
    };
    const { stdin, lastFrame, rerender, unmount } = render(
      React.createElement(UserInput, { ...props, isWaitingForResponse: true }),
    );
    try {
      await press(stdin, ESC);
      expect(lastFrame()).toContain("Stop the response?");
      rerender(
        React.createElement(UserInput, {
          ...props,
          isWaitingForResponse: false,
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(lastFrame()).not.toContain("Stop the response?");
      expect(props.onInterrupt).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
