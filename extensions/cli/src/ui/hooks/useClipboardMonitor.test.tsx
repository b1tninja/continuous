import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({ hasImage: false, probeMs: 228 }));
vi.mock("../../util/clipboard.js", () => ({
  checkClipboardForImage: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, clipboard.probeMs));
    return clipboard.hasImage;
  }),
  getClipboardImage: vi.fn(async () => null),
}));

import { checkClipboardForImage } from "../../util/clipboard.js";

import {
  CLIPBOARD_MAX_POLL_INTERVAL_MS,
  canProbeClipboard,
  useClipboardMonitor,
} from "./useClipboardMonitor.js";

const probes = () => vi.mocked(checkClipboardForImage).mock.calls.length;

function Input({
  keystrokes,
  enabled = true,
  interactive = true,
  onChange,
}: {
  keystrokes: number;
  enabled?: boolean;
  interactive?: boolean;
  onChange?: (hasImage: boolean) => void;
}) {
  useClipboardMonitor({
    // A new function on every render, as an inline prop would be
    onImageStatusChange: (hasImage) => onChange?.(hasImage),
    enabled,
    interactive,
    pollInterval: 2000,
  });
  return <Text>{keystrokes}</Text>;
}

describe("useClipboardMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(checkClipboardForImage).mockClear();
    clipboard.hasImage = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not probe again on every render", async () => {
    const { rerender, unmount } = render(<Input keystrokes={0} />);
    await vi.advanceTimersByTimeAsync(300);
    expect(probes()).toBe(1);

    // Eight keystrokes a second for two seconds
    for (let i = 1; i <= 16; i++) {
      rerender(<Input keystrokes={i} />);
      await vi.advanceTimersByTimeAsync(125);
    }
    // Only the scheduled probe 2 s after the first one finished
    expect(probes()).toBe(2);
    unmount();
  });

  it("backs off while the clipboard does not change", async () => {
    const { unmount } = render(<Input keystrokes={0} />);
    await vi.advanceTimersByTimeAsync(60_000);
    // At about 0, 2.2, 6.5, 14.7, 30.9 and 47.1 s (waits of 2, 4, 8 and then
    // 16 s): 6 probes, against 31 with a fixed 2 s poll
    expect(probes()).toBe(6);
    const before = probes();
    await vi.advanceTimersByTimeAsync(CLIPBOARD_MAX_POLL_INTERVAL_MS + 300);
    expect(probes()).toBe(before + 1);
    unmount();
  });

  it("reports a change, through the latest callback, and polls fast again", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender, unmount } = render(
      <Input keystrokes={0} onChange={first} />,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    rerender(<Input keystrokes={1} onChange={latest} />);

    clipboard.hasImage = true;
    await vi.advanceTimersByTimeAsync(CLIPBOARD_MAX_POLL_INTERVAL_MS + 300);
    expect(latest).toHaveBeenCalledWith(true);
    expect(first).not.toHaveBeenCalled();

    // Back to the base interval after a change
    const afterChange = probes();
    await vi.advanceTimersByTimeAsync(2300);
    expect(probes()).toBe(afterChange + 1);
    unmount();
  });

  it("starts no probe when the terminal is not interactive", async () => {
    const { unmount } = render(<Input keystrokes={0} interactive={false} />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes()).toBe(0);
    unmount();
  });

  it("stops while disabled and starts again from the base interval", async () => {
    const { rerender, unmount } = render(<Input keystrokes={0} />);
    await vi.advanceTimersByTimeAsync(30_000);
    rerender(<Input keystrokes={0} enabled={false} />);
    const whileDisabled = probes();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes()).toBe(whileDisabled);

    rerender(<Input keystrokes={0} enabled />);
    await vi.advanceTimersByTimeAsync(300);
    expect(probes()).toBe(whileDisabled + 1);
    await vi.advanceTimersByTimeAsync(2300);
    expect(probes()).toBe(whileDisabled + 2);
    unmount();
  });

  it("leaves no timer behind after unmount", async () => {
    const { unmount } = render(<Input keystrokes={0} />);
    await vi.advanceTimersByTimeAsync(300);
    unmount();
    const atUnmount = probes();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probes()).toBe(atUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("canProbeClipboard", () => {
  it("needs both stdin and stdout to be terminals", () => {
    expect(canProbeClipboard({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(canProbeClipboard({ isTTY: true }, {})).toBe(false);
    expect(canProbeClipboard({}, { isTTY: true })).toBe(false);
    expect(canProbeClipboard({}, {})).toBe(false);
  });
});
