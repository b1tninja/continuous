import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import {
  addRequestUsageToSession,
  setPromptCacheState,
} from "../../../redux/slices/sessionSlice";
import { setPromptCacheSetting } from "../../../redux/slices/uiSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import InputToolbar from "../InputToolbar";
import { MEDIUM_MIN_PX, WIDE_MIN_PX, widthTier } from "./widthTier";

// A regional Bedrock Claude: it takes the reasoning switch and the cache
// setting, and it has a tip (the global profile), so every control shows.
const selected = {
  title: "Sonnet (Bedrock)",
  provider: "bedrock",
  model: "us.anthropic.claude-sonnet-4-6",
  underlyingProviderName: "bedrock",
  contextLength: 200000,
};
// The usage below is reported for this one, which has a known price.
const priced = {
  title: "Claude Sonnet",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  underlyingProviderName: "anthropic",
  contextLength: 200000,
};

/** Renders the row as if it were `width` px wide. */
async function renderAt(width: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 24,
    top: 0,
    left: 0,
    right: width,
    bottom: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(
    <InputToolbar activeKey={null} onEnter={vi.fn()} isMainInput />,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          chat: selected,
        },
        modelsByRole: {
          ...EMPTY_CONFIG.modelsByRole,
          chat: [selected, priced],
        },
      } as any),
    );
    store.dispatch(
      setPromptCacheSetting({ modelTitle: selected.title, setting: "5m" }),
    );
    store.dispatch(
      addRequestUsageToSession({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { promptTokens: 20000, completionTokens: 0 },
      }),
    );
  });
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const WIDTHS = [200, 280, 299, 300, 360, 599, 600, 800];

describe("status row width ladder", () => {
  it("maps widths to tiers at the documented steps", () => {
    expect(widthTier(MEDIUM_MIN_PX - 1)).toBe("narrow");
    expect(widthTier(MEDIUM_MIN_PX)).toBe("medium");
    expect(widthTier(WIDE_MIN_PX - 1)).toBe("medium");
    expect(widthTier(WIDE_MIN_PX)).toBe("wide");
  });

  it.each(WIDTHS)(
    "at %i px cost and context are in the row, not in a menu",
    async (width) => {
      await renderAt(width);
      const row = screen.getByTestId("input-toolbar");
      expect(row.getAttribute("data-width-tier")).toBe(widthTier(width));
      const status = screen.getByTestId("input-status-group");
      const meter = within(status).getByTestId("context-meter");
      expect(meter.textContent).toMatch(/^(Context )?10%$/);
      expect(meter.getAttribute("aria-label")).toBe("Context 10% used");
      const usage = within(status).getByTestId("usage-indicator");
      expect(usage.textContent).toBe("$0.06");
      expect(usage.getAttribute("aria-label")).toBe(
        "$0.06: estimated cost $0.06. Show usage details",
      );
      // The meter sits right before the cost
      expect(meter.compareDocumentPosition(usage)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // No "..." menu any more
      expect(screen.queryByTestId("input-overflow-button")).toBeNull();
      expect(screen.queryByRole("button", { name: /More options/ })).toBeNull();
    },
  );

  it.each(WIDTHS)(
    "at %i px the reasoning, cache and tips controls are in the row",
    async (width) => {
      await renderAt(width);
      const status = screen.getByTestId("input-status-group");
      for (const id of [
        "reasoning-toggle",
        "prompt-cache-button",
        "cache-tips-button",
      ]) {
        const el = within(status).getByTestId(id);
        expect(el.tagName).toBe("BUTTON");
        // In the Tab order, not behind another control
        expect(el.closest("[role=menu],[role=dialog],[inert]")).toBeNull();
      }
    },
  );

  it("drops labels first: words when wide, numbers and icons when narrow", async () => {
    await renderAt(800);
    expect(screen.getByTestId("context-meter").textContent).toBe("Context 10%");
    expect(screen.getByTestId("reasoning-toggle-label")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-cache-state").textContent).toBe(
      "Cache cold",
    );
    expect(screen.getByTestId("cache-tips-count").textContent).toBe("1 tip");
    expect(screen.getByTestId("active-file-button")).toBeInTheDocument();
  });

  it("at medium width keeps numbers and the cache state word", async () => {
    await renderAt(360);
    expect(screen.getByTestId("context-meter").textContent).toBe("10%");
    expect(screen.queryByTestId("reasoning-toggle-label")).toBeNull();
    expect(screen.getByTestId("prompt-cache-state").textContent).toBe("cold");
    expect(screen.getByTestId("cache-tips-count").textContent).toBe("1");
    expect(screen.queryByTestId("active-file-button")).toBeNull();
  });

  it("at narrow width shows icons and numbers only", async () => {
    await renderAt(280);
    expect(screen.getByTestId("context-meter").textContent).toBe("10%");
    expect(screen.getByTestId("usage-indicator").textContent).toBe("$0.06");
    expect(screen.queryByTestId("prompt-cache-state")).toBeNull();
    expect(screen.getByTestId("cache-tips-count").textContent).toBe("1");
    expect(screen.queryByTestId("active-file-button")).toBeNull();
  });
});

describe("status row accessible names", () => {
  it("every control says its state without a tooltip", async () => {
    const store = await renderAt(280);
    expect(
      screen.getByRole("button", { name: "Reasoning off" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Prompt cache cold" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^1 tip about this model/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Context 10% used" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "$0.06: estimated cost $0.06. Show usage details",
      }),
    ).toBeInTheDocument();

    // A warm cache names the time left
    await act(async () => {
      store.dispatch(
        setPromptCacheState({
          escalated: false,
          lastRequestAt: Date.now(),
          lastTtl: "5m",
        }),
      );
    });
    expect(
      screen.getByRole("button", {
        name: /^Prompt cache \d:\d\d left$/,
      }),
    ).toBeInTheDocument();
  });

  it("the reasoning switch toggles from the keyboard", async () => {
    await renderAt(360);
    const user = userEvent.setup();
    screen.getByTestId("reasoning-toggle").focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("button", { name: "Reasoning on" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("the usage details open from the keyboard, no hover needed", async () => {
    await renderAt(280);
    const user = userEvent.setup();
    screen.getByTestId("usage-indicator").focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByTestId("usage-panel");
    expect(panel.textContent).toContain("Context: 20k of 200k tokens (10%)");
    expect(panel.textContent).toContain("Estimated cost");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("usage-panel")).toBeNull();
  });

  it("the context details open from the keyboard, with Compact now in them", async () => {
    await renderAt(280);
    const user = userEvent.setup();
    screen.getByTestId("context-meter").focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByTestId("context-panel");
    expect(panel.textContent).toContain("Context: 20k of 200k tokens (10%)");
    expect(
      within(panel).getByRole("button", { name: "Compact now" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("context-panel")).toBeNull();
  });
});
