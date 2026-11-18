import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import ThinkingBlockPeek from "./ThinkingBlockPeek";

async function setup(keepThinkingExpanded = false) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const props = { index: 1, prevItem: null };
  const view = await renderWithProviders(
    <ThinkingBlockPeek {...props} content="Reading" inProgress />,
    { store, mockIdeMessenger: ideMessenger },
  );
  // After the render: the initial config load would replace it
  await act(async () => {
    store.dispatch(
      updateConfig({ ...EMPTY_CONFIG, ui: { keepThinkingExpanded } }),
    );
  });
  const rerender = async (content: string, inProgress: boolean) => {
    await act(async () => {
      view.rerender(
        <ThinkingBlockPeek
          {...props}
          content={content}
          inProgress={inProgress}
        />,
      );
    });
  };
  return { ...view, rerender };
}

const toggle = () => screen.getByTestId("thinking-block-peek");
const body = () => screen.getByTestId("thinking-block-content");

describe("ThinkingBlockPeek", () => {
  it("is open while the model thinks, and shows the text as it streams", async () => {
    const { rerender } = await setup();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(toggle()).toHaveTextContent("Thinking");
    expect(body()).toBeVisible();
    await rerender("Reading the parser first", true);
    expect(body()).toHaveTextContent("Reading the parser first");
  });

  it("follows the newest text while it streams", async () => {
    const { rerender } = await setup();
    const el = body();
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    await rerender("Reading the parser first, then the tests", true);
    expect(el.scrollTop).toBe(900);
  });

  it("stops following once the person scrolls up to read", async () => {
    const { rerender } = await setup();
    const el = body();
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      value: 300,
    });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    await rerender("More thinking", true);
    expect(el.scrollTop).toBe(100);
  });

  it("folds to one line with the time taken when the thinking ends, and reopens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
      const { rerender } = await setup();
      vi.setSystemTime(new Date("2026-11-13T10:00:04.200Z"));
      await rerender("Reading the parser first", false);
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
      expect(toggle()).toHaveTextContent("Thought for 4.2s");
      expect(body()).not.toBeVisible();

      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute("aria-expanded", "true");
      expect(body()).toBeVisible();
      // Still there: folding never removes the thinking
      expect(body()).toHaveTextContent("Reading the parser first");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays folded when the person folds it while it streams", async () => {
    const { rerender } = await setup();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await rerender("Reading the parser first", true);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open after the answer with ui.keepThinkingExpanded", async () => {
    const { rerender } = await setup(true);
    await rerender("Reading the parser first", false);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(body()).toBeVisible();
  });

  it("uses the times it is given for thinking from <think> tags", async () => {
    await renderWithProviders(
      <ThinkingBlockPeek
        index={0}
        prevItem={null}
        content="tagged"
        startAt={1000}
        endAt={3500}
      />,
    );
    expect(toggle()).toHaveTextContent("Thought for 2.5s");
  });
});
