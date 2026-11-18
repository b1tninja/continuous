import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { noteChatDebug, resetChatDebugForTests } from "../../util/chatDebugLog";
import { ChatDebugLog } from "./ChatDebugLog";

afterEach(() => {
  resetChatDebugForTests();
});

describe("ChatDebugLog", () => {
  it("keeps the event list out of the layout until it is opened", () => {
    render(<ChatDebugLog />);
    expect(screen.queryByTestId("chat-debug-log")).toBeNull();
    expect(screen.queryByText("Nothing recorded yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostic log" }));
    expect(screen.getByTestId("chat-debug-log")).toBeTruthy();
    expect(screen.getByText("Nothing recorded yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostic log" }));
    expect(screen.queryByTestId("chat-debug-log")).toBeNull();
  });

  it("shows recent events and clears them", () => {
    noteChatDebug("stream-empty", "Stream stopped with no reply text");
    noteChatDebug("tool-error", "read_file failed: disk full");
    render(<ChatDebugLog />);
    fireEvent.click(
      screen.getByRole("button", { name: "Diagnostic log, 2 events" }),
    );
    const events = screen.getAllByTestId("chat-debug-event");
    expect(events).toHaveLength(2);
    expect(events[0].textContent).toContain(
      "Stream stopped with no reply text",
    );
    expect(events[1].textContent).toContain("read_file failed");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("chat-debug-event")).toBeNull();
    expect(screen.getByText("Nothing recorded yet.")).toBeTruthy();
  });
});
