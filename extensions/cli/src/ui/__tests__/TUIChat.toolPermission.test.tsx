import { refusalText } from "core/tools/refusalText.js";
import { render } from "ink-testing-library";
import React from "react";
import { vi } from "vitest";

import type {
  ToolCallState,
  ChatHistoryItem,
} from "../../../../../core/index.js";
import { ToolPermissionSelector } from "../components/ToolPermissionSelector.js";
import { CONFIRM_ARM_MS } from "../hooks/useInterruptConfirm.js";

describe("TUIChat - Tool Permission Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("shows ToolPermissionSelector with correct content", async () => {
    const handleResponse = vi.fn();

    const { lastFrame } = render(
      <ToolPermissionSelector
        toolName="Edit"
        toolArgs={{
          file_path: "/path/to/test.txt",
          old_string: "old content",
          new_string: "new content",
        }}
        requestId="test-request-123"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    const frame = lastFrame();

    // Verify ToolPermissionSelector is shown
    expect(frame).toContain("Edit");
    expect(frame).toContain("Would you like to continue?");
    expect(frame).toContain("Continue");
    expect(frame).toContain("Continue + always allow");
    expect(frame).toContain("No, and tell Continue what to do differently");
    expect(frame).toContain("(tab)");
    expect(frame).toContain("(a)");
    expect(frame).toContain("(esc)");
    // Verify old Cancel option is not shown
    expect(frame).not.toContain("Cancel");
  });

  it("handles keyboard shortcuts for permission approval and rejection", async () => {
    const handleResponse = vi.fn();

    const { stdin } = render(
      <ToolPermissionSelector
        toolName="Write"
        toolArgs={{
          file_path: "/path/to/new-file.txt",
          content: "Hello, world!",
        }}
        requestId="test-request-123"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    // Test Tab key for approval
    stdin.write("\t");

    await vi.advanceTimersByTimeAsync(50);

    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-123",
      true,
      false,
      false,
    );
  });

  it("handles escape key for rejection", async () => {
    const handleResponse = vi.fn();

    const { stdin } = render(
      <ToolPermissionSelector
        toolName="Bash"
        toolArgs={{
          command: "rm -rf /",
        }}
        requestId="test-request-456"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    // Test escape key for rejection
    stdin.write("\x1b"); // ESC key

    await vi.advanceTimersByTimeAsync(50);

    // Esc denies this call only; the turn goes on
    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-456",
      false,
      false,
      false,
    );
  });

  it("handles 'n' key for rejection, after the stop question", async () => {
    const handleResponse = vi.fn();

    const { stdin } = render(
      <ToolPermissionSelector
        toolName="Delete"
        toolArgs={{
          path: "/important/file.txt",
        }}
        requestId="test-request-789"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    // Test 'n' key for rejection: it ends the turn, so Enter confirms
    stdin.write("n");

    await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
    stdin.write("\r");
    await vi.advanceTimersByTimeAsync(50);

    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-789",
      false,
      false,
      true,
    );
  });

  it("handles arrow key navigation in permission selector", async () => {
    const handleResponse = vi.fn();

    const { lastFrame, stdin } = render(
      <ToolPermissionSelector
        toolName="Read"
        toolArgs={{
          file_path: "/path/to/secret.txt",
        }}
        requestId="test-request-123"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    // Initial state should show "> Continue" selected
    const frame = lastFrame();
    expect(frame).toMatch(/>\s+Continue/);

    // Test that pressing Enter on default selection triggers approval
    stdin.write("\r");
    await vi.advanceTimersByTimeAsync(50);

    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-123",
      true,
      undefined,
      undefined,
    );
  });

  it("handles the a key for policy creation", async () => {
    const handleResponse = vi.fn();

    const { stdin } = render(
      <ToolPermissionSelector
        toolName="Bash"
        toolArgs={{
          command: "ls -la",
        }}
        requestId="test-request-policy"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    // Test the a key for approval with policy creation
    stdin.write("a");

    await vi.advanceTimersByTimeAsync(50);

    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-policy",
      true,
      true,
      false,
    );
  });

  it("shows the new 'No, and tell Continue what to do differently' option in the UI", async () => {
    const handleResponse = vi.fn();

    const { lastFrame } = render(
      <ToolPermissionSelector
        toolName="Edit"
        toolArgs={{
          file_path: "/path/to/test.txt",
          old_string: "old content",
          new_string: "new content",
        }}
        requestId="test-request-stop"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    // Verify the new option exists in the rendered output
    const frame = lastFrame();
    expect(frame).toContain("No, and tell Continue what to do differently");

    // Verify all 3 options are present
    expect(frame).toContain("Continue");
    expect(frame).toContain("Continue + always allow");
    expect(frame).toContain("No, and tell Continue what to do differently");
    // Verify old Cancel option is not shown
    expect(frame).not.toContain("Cancel");
  });

  it("escape denies the call without stopping the response", async () => {
    // No single key ends the turn: Esc is "No, skip this call"
    const handleResponse = vi.fn();

    const { stdin } = render(
      <ToolPermissionSelector
        toolName="Edit"
        toolArgs={{
          file_path: "/path/to/test.txt",
          old_string: "old content",
          new_string: "new content",
        }}
        requestId="test-request-escape"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    stdin.write("\x1b"); // ESC key

    await vi.advanceTimersByTimeAsync(50);

    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-escape",
      false, // approved = false (rejection)
      false, // createPolicy = false
      false, // stopStream = false: the turn goes on
    );
  });

  it("'n' asks before it stops the response; Enter stops, Esc goes back", async () => {
    // "No, and tell Continue what to do differently" ends the turn, so it asks
    const handleResponse = vi.fn();

    const { stdin, lastFrame } = render(
      <ToolPermissionSelector
        toolName="Write"
        toolArgs={{
          file_path: "/path/to/new-file.txt",
          content: "New content",
        }}
        requestId="test-request-n-key"
        onResponse={handleResponse}
      />,
    );

    await vi.advanceTimersByTimeAsync(50);

    stdin.write("n");
    await vi.advanceTimersByTimeAsync(50);
    expect(handleResponse).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Stop the response?");

    // Esc goes back to the question about the call
    stdin.write("\x1b");
    await vi.advanceTimersByTimeAsync(50);
    expect(handleResponse).not.toHaveBeenCalled();
    expect(lastFrame()).toContain("Would you like to continue?");

    // n again: an Enter at once (a repeat) does nothing, a later one stops
    stdin.write("n");
    await vi.advanceTimersByTimeAsync(10);
    stdin.write("\r");
    await vi.advanceTimersByTimeAsync(10);
    expect(handleResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONFIRM_ARM_MS);
    stdin.write("\r");
    await vi.advanceTimersByTimeAsync(50);
    expect(handleResponse).toHaveBeenCalledWith(
      "test-request-n-key",
      false, // approved = false (rejection)
      false, // createPolicy = false
      true, // stopStream = true (this is the new behavior)
    );
  });

  it("shows tool result with red dot and 'Cancelled by user' message", async () => {
    // Import the components we need for this test
    const { ToolResultSummary } = await import("../ToolResultSummary.js");
    const { MemoizedMessage } =
      await import("../components/MemoizedMessage.js");

    // Test the ToolResultSummary component directly
    const { lastFrame: summaryFrame } = render(
      <ToolResultSummary
        toolName="Edit"
        content={refusalText.declined("Edit")}
      />,
    );

    const summary = summaryFrame();
    expect(summary).toContain("Cancelled by user");

    // Test the MemoizedMessage component with a proper tool result in ChatHistoryItem
    const toolCallState: ToolCallState = {
      toolCallId: "test-tool-call",
      toolCall: {
        id: "test-tool-call",
        type: "function",
        function: {
          name: "Edit",
          arguments: JSON.stringify({ file_path: "test.txt" }),
        },
      },
      status: "errored", // Set to errored to show red dot
      parsedArgs: { file_path: "test.txt" },
      output: [
        {
          name: "tool_result",
          content: refusalText.declined("Edit"),
          description: "Tool execution denied",
        },
      ],
    };

    const historyItem: ChatHistoryItem = {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "test-tool-call",
            function: {
              name: "Edit",
              arguments: JSON.stringify({ file_path: "test.txt" }),
            },
            type: "function",
          },
        ],
      },
      contextItems: [],
      toolCallStates: [toolCallState],
    };

    const { lastFrame: messageFrame } = render(
      <MemoizedMessage item={historyItem} index={0} />,
    );

    await vi.advanceTimersByTimeAsync(100);

    const messageOutput = messageFrame();

    // Verify the red dot appears (for failed tool call)
    expect(messageOutput).toContain("●");

    // Verify the tool name appears
    expect(messageOutput).toContain("Edit");

    // The MemoizedMessage component correctly identifies this as a failure
    // because the tool result includes "Permission denied"
    // This causes the red dot to be shown
  });
});
