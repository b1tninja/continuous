import { act, fireEvent, screen } from "@testing-library/react";
import type { TaskPlan } from "core";
import { createLoop, enterWait } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  setTaskPlan,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { LoopStatusLine } from "./LoopStatusLine";

const PLAN = {
  items: [
    { id: "1", text: "Reproduce the failure", status: "done" },
    {
      id: "2",
      text: "A very long to-do that must not push the buttons off the line",
      status: "in_progress",
    },
  ],
  updatedAt: "2026-11-10T10:00:00Z",
} as TaskPlan;

async function setup(status: "running" | "waiting" = "running") {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const toggles: boolean[] = [];
  let loop = createLoop(PLAN, {
    now: new Date(),
    sessionTokens: 0,
    autonomy: "auto",
  });
  loop = {
    ...loop,
    title: "Fix the parser",
    items: loop.items.map((i) =>
      i.id === "1" ? { ...i, status: "done" as const } : i,
    ),
  };
  loop =
    status === "waiting"
      ? enterWait(loop, new Date())
      : ({
          ...loop,
          status: "running",
          current: {
            kind: "item",
            itemId: "2",
            historyIndex: 0,
            startedAt: new Date().toISOString(),
          },
        } as typeof loop);
  const view = await renderWithProviders(
    <LoopStatusLine
      loop={loop}
      taskPlan={PLAN}
      settingsOpen={false}
      onToggleSettings={() => toggles.push(true)}
    />,
    { store, mockIdeMessenger: ideMessenger },
  );
  await act(async () => {
    store.dispatch(newSession());
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loop));
  });
  return { ...view, store, toggles };
}

describe("LoopStatusLine", () => {
  it("shows the title (in full on the title attribute), progress, round and what runs now", async () => {
    await setup();
    expect(screen.getByTestId("loop-title").getAttribute("title")).toBe(
      "Fix the parser",
    );
    expect(screen.getByTestId("loop-state-word").textContent).toBe("Running");
    expect(screen.getByTestId("loop-strip-done").textContent).toBe("1/2");
    expect(screen.getByTestId("loop-strip-round").textContent).toMatch(/^R1/);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
    expect(screen.getByTestId("loop-now").textContent).toContain(
      "A very long to-do",
    );
  });

  it("states the state in a word as well as a colour", async () => {
    await setup("waiting");
    expect(screen.getByTestId("loop-strip").getAttribute("data-state")).toBe(
      "waiting",
    );
    expect(screen.getByTestId("loop-state-word").textContent).toBe(
      "Waiting for your answer",
    );
  });

  it("Stop is stop after this item; Stop now sits in the menu", async () => {
    await setup();
    const stop = screen.getByTestId("loop-stop");
    expect(stop.textContent).toBe("Stop");
    expect(stop.getAttribute("aria-label")).toBe("Stop after this item");
    expect(screen.queryByTestId("loop-stop-now")).toBeNull();
    const menu = screen.getByTestId("loop-stop-menu");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(menu));
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("loop-stop-now").textContent).toBe("Stop now");
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("loop-stop-options")).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("the gear asks for the settings and is named", async () => {
    const { toggles } = await setup();
    const gear = screen.getByTestId("loop-settings-toggle");
    expect(gear.getAttribute("aria-label")).toBe("Loop settings");
    await act(async () => fireEvent.click(gear));
    expect(toggles).toHaveLength(1);
  });

  it("jumps to the latest plan tile", async () => {
    await setup();
    const tile = document.createElement("div");
    tile.setAttribute("data-testid", "plan-card");
    let scrolled = false;
    tile.scrollIntoView = () => {
      scrolled = true;
    };
    document.body.appendChild(tile);
    await act(async () =>
      fireEvent.click(screen.getByTestId("loop-jump-to-plan")),
    );
    expect(scrolled).toBe(true);
    tile.remove();
  });
});
