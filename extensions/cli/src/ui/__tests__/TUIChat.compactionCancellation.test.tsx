import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUITestContext } from "../../test-helpers/ui-test-context.js";
import { AppRoot } from "../AppRoot.js";
import { CONFIRM_ARM_MS } from "../hooks/useInterruptConfirm.js";

// ink 8 holds a lone ESC for ~20ms to tell it apart from the start of an
// escape sequence, so a keypress must be followed by a short wait (and two
// presses written back to back would be read as a single Meta+Esc).
const pressEsc = async (stdin: { write: (data: string) => void }) => {
  stdin.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 50));
};

// Mock the useChat hook to control state
const mockUseChat = vi.fn();
const mockHandleInterrupt = vi.fn();

vi.mock("../hooks/useChat.js", () => ({
  useChat: () => mockUseChat(),
}));

describe("TUIChat - Compaction Cancellation", () => {
  let context: any;

  beforeEach(() => {
    context = createUITestContext({
      allServicesReady: true,
      serviceState: "ready",
    });

    // Reset the mock
    mockHandleInterrupt.mockClear();
  });

  afterEach(() => {
    context.cleanup();
    vi.clearAllMocks();
  });

  it("asks when ESC is pressed during compaction, and Enter interrupts", async () => {
    const compactionStartTime = Date.now();

    mockUseChat.mockReturnValue({
      chatHistory: [],
      setChatHistory: vi.fn(),
      isWaitingForResponse: false,
      responseStartTime: null,
      isCompacting: true,
      compactionStartTime,
      inputMode: true, // Changed to true so ESC handling is active
      attachedFiles: [],
      activePermissionRequest: null,
      wasInterrupted: false,
      handleUserMessage: vi.fn(),
      handleInterrupt: mockHandleInterrupt,
      handleFileAttached: vi.fn(),
      resetChatHistory: vi.fn(),
      handleToolPermissionResponse: vi.fn(),
    });

    const { stdin, lastFrame, unmount } = render(
      React.createElement(AppRoot, {}),
    );

    try {
      // One ESC asks and does not interrupt; a second keeps it going
      await pressEsc(stdin);
      expect(mockHandleInterrupt).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("Stop the response?");
      await pressEsc(stdin);
      expect(lastFrame()).not.toContain("Stop the response?");
      expect(mockHandleInterrupt).not.toHaveBeenCalled();

      await pressEsc(stdin);
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_ARM_MS));
      stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockHandleInterrupt).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });

  it("shows compaction status with esc to interrupt message", () => {
    const compactionStartTime = Date.now();

    mockUseChat.mockReturnValue({
      chatHistory: [],
      setChatHistory: vi.fn(),
      isWaitingForResponse: false,
      responseStartTime: null,
      isCompacting: true,
      compactionStartTime,
      inputMode: false,
      attachedFiles: [],
      activePermissionRequest: null,
      wasInterrupted: false,
      handleUserMessage: vi.fn(),
      handleInterrupt: mockHandleInterrupt,
      handleFileAttached: vi.fn(),
      resetChatHistory: vi.fn(),
      handleToolPermissionResponse: vi.fn(),
    });

    const { lastFrame, unmount } = render(React.createElement(AppRoot, {}));

    try {
      const frame = lastFrame();
      expect(frame).toBeDefined();

      // Should show compaction message with interrupt option
      expect(frame).toContain("Compacting history");
      expect(frame).toContain("esc to interrupt");
    } finally {
      unmount();
    }
  });

  it("prioritizes compaction cancellation over response cancellation", async () => {
    // This tests the case where both might be true (theoretical edge case)
    const compactionStartTime = Date.now();
    const responseStartTime = Date.now();

    mockUseChat.mockReturnValue({
      chatHistory: [],
      setChatHistory: vi.fn(),
      isWaitingForResponse: true,
      responseStartTime,
      isCompacting: true,
      compactionStartTime,
      inputMode: false,
      attachedFiles: [],
      activePermissionRequest: null,
      wasInterrupted: false,
      handleUserMessage: vi.fn(),
      handleInterrupt: mockHandleInterrupt,
      handleFileAttached: vi.fn(),
      resetChatHistory: vi.fn(),
      handleToolPermissionResponse: vi.fn(),
    });

    const { stdin, lastFrame, unmount } = render(
      React.createElement(AppRoot, {}),
    );

    try {
      // Simulate ESC key press when both states are active: it asks first
      await pressEsc(stdin);
      expect(mockHandleInterrupt).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("Stop the response?");

      // Enter stops (handleInterrupt prioritizes compaction)
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_ARM_MS));
      stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockHandleInterrupt).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });
});
