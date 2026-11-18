import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PolicyCard } from "../../PolicyControls";
import { LoopPhaseMark } from "../../LoopPhaseMark";
import { ModeIcon } from "../../ModeSelect/ModeIcon";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setIsInEdit } from "../../../redux/slices/sessionSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import InputToolbar from "../InputToolbar";
import { isInlineToolbarKind } from "./LumpToolbar/LumpToolbar";
import { Lump } from "./index";
import { SessionControls } from "./SessionControls";

async function setup(ui = <Lump />) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(ui, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return { ...view, store };
}

describe("Lump session controls", () => {
  it("holds the mode and policy controls above the input, before the toolbox", async () => {
    await setup();
    const group = screen.getByRole("toolbar", { name: "Session controls" });
    expect(within(group).getByTestId("mode-select-button")).toBeTruthy();
    const controls = within(group).getByTestId("policy-controls");
    expect(within(controls).getByTestId("policy-preset")).toBeTruthy();
    for (const area of ["context", "tools", "edits", "plan", "questions"]) {
      expect(
        within(controls).getByTestId(`policy-select-${area}`),
      ).toHaveAttribute("aria-label");
    }
    // Focus order: session controls first, toolbox after
    const toolbox = screen.getByTestId("toolbox-toggle");
    expect(
      group.compareDocumentPosition(toolbox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("folds the five area dropdowns behind a toggle that reports its state", async () => {
    const { user } = await setup();
    const toggle = screen.getByTestId("policy-areas-toggle");
    const areas = document.getElementById(
      toggle.getAttribute("aria-controls")!,
    )!;
    expect(toggle).toHaveAttribute("aria-label", "Show policy areas");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(areas.className).toContain("hidden");
    expect(areas.className).toContain("lg:flex");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Hide policy areas");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(areas.className).not.toContain("hidden");
  });

  it("drops the session controls in edit mode, as the bottom row did", async () => {
    const { store } = await setup(<SessionControls />);
    expect(screen.getByTestId("session-controls")).toBeTruthy();
    await act(async () => {
      store.dispatch(setIsInEdit(true));
    });
    expect(screen.queryByTestId("session-controls")).toBeNull();
    expect(screen.queryByTestId("mode-select-button")).toBeNull();
  });

  it("shares the row only with one-line toolbars", () => {
    expect(isInlineToolbarKind("idle")).toBe(true);
    expect(isInlineToolbarKind("streaming")).toBe(true);
    expect(isInlineToolbarKind("terminal")).toBe(true);
    expect(isInlineToolbarKind("pending-tool-calls")).toBe(false);
    expect(isInlineToolbarKind("pending-apply")).toBe(false);
    expect(isInlineToolbarKind("edit")).toBe(false);
  });
});

describe("input bottom row", () => {
  it("keeps the model choice and send, and no longer renders mode or policy", async () => {
    await setup(<InputToolbar activeKey={null} isMainInput />);
    expect(screen.getByTestId("submit-input-button")).toBeTruthy();
    expect(screen.queryByTestId("mode-select-button")).toBeNull();
    expect(screen.queryByTestId("policy-controls")).toBeNull();
  });
});

describe("Lump session toolbar", () => {
  it("is one toolbar with every control named", async () => {
    await setup();
    const bar = screen.getByRole("toolbar", { name: "Session controls" });
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    expect(names.some((n) => n.includes("Careful"))).toBe(true);
    expect(names).toContain("Context use: Permissive");
    expect(names).toContain("Plan edits: Cautious");
    expect(within(bar).getByTestId("mode-select-button")).toBeTruthy();
  });

  it("has one Tab stop; arrows, Home and End move it", async () => {
    const { user } = await setup();
    const bar = screen.getByRole("toolbar", { name: "Session controls" });
    const stops = () =>
      Array.from(bar.querySelectorAll<HTMLElement>("[data-roving]")).filter(
        (e) => e.tabIndex === 0,
      );
    const all = bar.querySelectorAll("[data-roving]");
    // Mode, preset, fold toggle, five areas and the safety shield: 9 controls, 1 Tab stop
    expect(all).toHaveLength(9);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].getAttribute("data-testid")).toBe("mode-select-button");
    stops()[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      within(bar).getByTestId("policy-preset"),
    );
    expect(stops()).toEqual([document.activeElement]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(
      within(bar).getByTestId("safety-shield-toggle"),
    );
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      within(bar).getByTestId("mode-select-button"),
    );
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(
      within(bar).getByTestId("safety-shield-toggle"),
    );
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(
      within(bar).getByTestId("mode-select-button"),
    );
  });

  it("a chip opens its menu from the keyboard, and each level has a one-line tooltip", async () => {
    const { user } = await setup();
    screen.getByTestId("policy-select-edits").focus();
    await user.keyboard("{ArrowDown}");
    const option = screen.getByTestId("policy-option-edits-manual");
    expect(option.querySelector("[title]")?.getAttribute("title")).toBe(
      "Manual: You review each diff.",
    );
  });

  it("no id or test id is used twice when Settings shows the same controls", async () => {
    await setup(
      <>
        <Lump />
        <PolicyCard />
        <ModeIcon mode="loop" />
        <LoopPhaseMark />
      </>,
    );
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const testIds = Array.from(document.querySelectorAll("[data-testid]")).map(
      (e) => e.getAttribute("data-testid"),
    );
    const dupes = testIds.filter((t, i) => testIds.indexOf(t) !== i);
    expect(dupes).toEqual([]);
    expect(screen.getByTestId("policy-preset-settings")).toBeTruthy();
    expect(screen.getByTestId("loop-phase-mode")).toBeTruthy();
  });
});
