import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LoopState, TaskPlan } from "core";
import { createLoop, type ReplanDiff } from "core/util/loopMode";
import { Provider } from "react-redux";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setupStore } from "../../redux/store";
import { getAnnouncement, resetAnnouncer } from "../a11y/announcer";
import { PlanTree } from "./PlanTree";

const T0 = new Date();

function planOf(n: number): TaskPlan {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: String(i + 1),
      text: `To-do ${i + 1}`,
      status: "pending" as const,
    })),
    updatedAt: T0.toISOString(),
  };
}

type Patch = Partial<LoopState["items"][number]>;

function loopOf(
  n: number,
  items: Record<string, Patch> = {},
  patch: Partial<LoopState> = {},
): LoopState {
  const loop = createLoop(planOf(n), { now: T0, sessionTokens: 0 });
  return {
    ...loop,
    items: loop.items.map((i) => ({ ...i, ...items[i.id] })),
    ...patch,
  };
}

function runningOn(id: string): Partial<LoopState> {
  return {
    current: {
      kind: "item",
      itemId: id,
      historyIndex: 0,
      startedAt: T0.toISOString(),
    },
  };
}

function mount(ui: React.ReactElement) {
  const store = setupStore({ ideMessenger: new MockIdeMessenger() });
  const wrap = (el: React.ReactElement) => (
    <Provider store={store}>{el}</Provider>
  );
  const view = render(wrap(ui));
  return {
    ...view,
    rerenderTree: (el: React.ReactElement) => view.rerender(wrap(el)),
  };
}

/** Seven to-dos: 1 and 2 done, 3 running, the rest to do */
function running() {
  return loopOf(
    7,
    {
      "1": { status: "done" },
      "2": { status: "done" },
      "3": { status: "running", attempts: 1 },
    },
    runningOn("3"),
  );
}

const root = () => screen.getByTestId("plan-tree-root");
const item = (id: string) => screen.getByTestId(`plan-tree-item-${id}`);

beforeEach(() => resetAnnouncer());

describe("PlanTree: roles, folds and the current item", () => {
  it("is collapsed by default, named, with tree semantics", () => {
    mount(<PlanTree loop={running()} plan={planOf(7)} />);
    const tree = screen.getByRole("tree", { name: "Plan to-dos" });
    expect(tree).toBeTruthy();
    expect(root().getAttribute("role")).toBe("treeitem");
    expect(root().getAttribute("aria-expanded")).toBe("false");
    expect(root().textContent).toContain("now item 3 · 2/7 done");
    expect(screen.queryAllByRole("treeitem")).toHaveLength(1);
  });

  it("opens in place on one click: fold of the done items, current item open, upcoming rows", async () => {
    const user = userEvent.setup();
    mount(<PlanTree loop={running()} plan={planOf(7)} />);
    await user.click(within(root()).getByText("To-dos"));
    expect(root().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("group").length).toBeGreaterThan(0);
    const done = screen.getByTestId("plan-tree-fold-done");
    expect(done.textContent).toContain("2 done");
    expect(done.getAttribute("aria-expanded")).toBe("false");
    // the current item
    const current = item("3");
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(current.getAttribute("aria-expanded")).toBe("true");
    expect(current.textContent).toContain("running, 3. To-do 3");
    expect(screen.getByTestId("plan-tree-line-live").textContent).toContain(
      "Running: ",
    );
    // upcoming ones: one line each, leaves carry no aria-expanded
    expect(item("4").getAttribute("aria-expanded")).toBeNull();
    expect(item("4").textContent).toContain("to do, 4. To-do 4");
    expect(item("7")).toBeTruthy();
    // finished ones are in the fold, not in the tree until it is opened
    expect(screen.queryByTestId("plan-tree-item-1")).toBeNull();
    await user.click(within(done).getByText("2 done"));
    expect(done.getAttribute("aria-expanded")).toBe("true");
    expect(item("1").textContent).toContain("done, 1. To-do 1");
    await user.click(within(done).getByText("2 done"));
    expect(screen.queryByTestId("plan-tree-item-1")).toBeNull();
  });

  it("folds what is far ahead into 'N more to do' and unfolds it on click", async () => {
    const user = userEvent.setup();
    const loop = loopOf(
      12,
      { "1": { status: "running", attempts: 1 } },
      runningOn("1"),
    );
    mount(<PlanTree loop={loop} plan={planOf(12)} />);
    await user.click(within(root()).getByText("To-dos"));
    const fold = screen.getByTestId("plan-tree-fold-upcoming");
    expect(fold.textContent).toContain("7 more to do");
    expect(screen.queryByTestId("plan-tree-item-12")).toBeNull();
    await user.click(within(fold).getByText("7 more to do"));
    expect(item("12")).toBeTruthy();
  });

  it("marks a failed item and opens by itself", () => {
    const loop = loopOf(4, {
      "1": { status: "done" },
      "2": {
        status: "failed",
        attempts: 2,
        check: {
          status: "failed",
          command: "pytest -q",
          exitCode: 1,
          output: "2 failed, 10 passed",
          at: T0.toISOString(),
        },
      },
    });
    mount(<PlanTree loop={loop} plan={planOf(4)} />);
    expect(root().getAttribute("aria-expanded")).toBe("true");
    expect(root().textContent).toContain("item 2 failed");
    expect(item("2").textContent).toContain("failed, 2. To-do 2");
    expect(screen.getByTestId("plan-tree-line-check").textContent).toContain(
      "Check failed: pytest -q: 2 failed, 10 passed (attempt 2)",
    );
  });

  it("opens by itself while a re-plan waits, with dropped and new items marked", () => {
    const loop = loopOf(
      3,
      { "1": { status: "done" } },
      { status: "awaiting_plan" },
    );
    const plan = planOf(3);
    plan.items[2] = { ...plan.items[2], id: "9", text: "A new to-do" };
    const diff: ReplanDiff = {
      kept: [{ text: "To-do 1", status: "done" }, { text: "To-do 2" }],
      added: ["A new to-do"],
      dropped: [{ text: "Old to-do" }],
    };
    mount(<PlanTree loop={loop} plan={plan} diff={diff} />);
    expect(root().getAttribute("aria-expanded")).toBe("true");
    expect(root().textContent).toContain("plan waiting for you");
    expect(
      screen.getByTestId("plan-tree-item-dropped:0").textContent,
    ).toContain("dropped, Old to-do");
    expect(screen.getByTestId("plan-tree-item-dropped:0").innerHTML).toContain(
      "line-through",
    );
    expect(item("9").textContent).toContain("new");
    expect(screen.getByTestId("plan-tree-fold-kept").textContent).toContain(
      "1 kept, unchanged",
    );
  });

  it("opens when an item starts to fail, and stays closed by the person's choice afterwards", async () => {
    const user = userEvent.setup();
    const { rerenderTree } = mount(
      <PlanTree loop={running()} plan={planOf(7)} />,
    );
    expect(root().getAttribute("aria-expanded")).toBe("false");
    const failed = loopOf(7, { "3": { status: "failed", attempts: 1 } });
    rerenderTree(<PlanTree loop={failed} plan={planOf(7)} />);
    expect(root().getAttribute("aria-expanded")).toBe("true");
    // the person closes it; a re-render with the same state keeps it closed
    await user.click(within(root()).getByText("To-dos"));
    expect(root().getAttribute("aria-expanded")).toBe("false");
    rerenderTree(<PlanTree loop={{ ...failed }} plan={planOf(7)} />);
    expect(root().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows replaced and R chips, and follows 'replaced by' with Enter", async () => {
    const user = userEvent.setup();
    const loop = loopOf(
      4,
      { "1": { status: "done" }, "2": { status: "running", attempts: 1 } },
      runningOn("2"),
    );
    mount(
      <PlanTree
        loop={loop}
        plan={planOf(4)}
        extras={{ addedInRound: { "4": 2 }, replacedBy: { "1": "4" } }}
      />,
    );
    await user.click(within(root()).getByText("To-dos"));
    const fold = screen.getByTestId("plan-tree-fold-done");
    expect(fold.textContent).toContain("1 replaced");
    await user.click(within(fold).getByText("1 replaced"));
    const replaced = item("1");
    expect(replaced.textContent).toContain("replaced, 1. To-do 1");
    expect(replaced.textContent).toContain("replaced by 4");
    expect(replaced.innerHTML).toContain("line-through");
    expect(item("4").textContent).toContain("R2");
    act(() => replaced.focus());
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(item("4"));
  });
});

describe("PlanTree: keyboard", () => {
  async function open() {
    const user = userEvent.setup();
    mount(<PlanTree loop={running()} plan={planOf(7)} />);
    await user.click(within(root()).getByText("To-dos"));
    act(() => root().focus());
    return user;
  }

  it("has one tab stop: the focused row has tabindex 0, the others -1", async () => {
    await open();
    const stops = screen
      .getAllByRole("treeitem")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(root());
  });

  it("Down and Up move through the visible rows; Home and End jump", async () => {
    const user = await open();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByTestId("plan-tree-fold-done"),
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("3"));
    expect(item("3").getAttribute("tabindex")).toBe("0");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      screen.getByTestId("plan-tree-fold-done"),
    );
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(item("7"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(root());
  });

  it("Right opens a closed row, then steps into it; Left closes it, then steps out", async () => {
    const user = await open();
    await user.keyboard("{ArrowDown}");
    const done = screen.getByTestId("plan-tree-fold-done");
    expect(done.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{ArrowRight}");
    expect(done.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(item("1"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(done);
    await user.keyboard("{ArrowLeft}");
    expect(done.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(root());
  });

  it("Enter and Space toggle a row", async () => {
    const user = await open();
    await user.keyboard("{ArrowDown}");
    const done = screen.getByTestId("plan-tree-fold-done");
    await user.keyboard("{Enter}");
    expect(done.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard(" ");
    expect(done.getAttribute("aria-expanded")).toBe("false");
  });

  it("folding a row under focus falls back to the tree, and a new current item does not take focus", async () => {
    const user = userEvent.setup();
    const { rerenderTree } = mount(
      <PlanTree loop={running()} plan={planOf(7)} />,
    );
    await user.click(within(root()).getByText("To-dos"));
    act(() => item("4").focus());
    const next = loopOf(
      7,
      {
        "1": { status: "done" },
        "2": { status: "done" },
        "3": { status: "done" },
        "4": { status: "running", attempts: 1 },
      },
      runningOn("4"),
    );
    rerenderTree(<PlanTree loop={next} plan={planOf(7)} />);
    expect(item("4").getAttribute("aria-current")).toBe("step");
    expect(document.activeElement).toBe(item("4"));
    // closing the whole tree from the root: focus does not jump
    act(() => root().focus());
    fireEvent.keyDown(root(), { key: "ArrowLeft" });
    expect(root().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(root());
  });
});

describe("PlanTree: announcements go through the existing live regions", () => {
  it("adds no live region of its own", () => {
    const { container } = mount(<PlanTree loop={running()} plan={planOf(7)} />);
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelector("[role=status],[role=alert]")).toBeNull();
  });

  it("says nothing on mount, then announces a failure, a plan that waits and the end", () => {
    const { rerenderTree } = mount(
      <PlanTree loop={running()} plan={planOf(7)} />,
    );
    expect(getAnnouncement("polite").text).toBe("");

    const failed = loopOf(
      7,
      { "3": { status: "failed", attempts: 1 } },
      {
        current: {
          kind: "replan",
          itemId: "3",
          historyIndex: 0,
          startedAt: T0.toISOString(),
        },
      },
    );
    rerenderTree(<PlanTree loop={failed} plan={planOf(7)} />);
    expect(getAnnouncement("polite").text).toBe("Item 3 failed, repairing");

    const waiting = loopOf(7, {}, { status: "awaiting_plan" });
    const diff: ReplanDiff = { kept: [], added: ["x"], dropped: [] };
    rerenderTree(<PlanTree loop={waiting} plan={planOf(7)} diff={diff} />);
    expect(getAnnouncement("polite").text).toBe(
      "Loop waiting for you: new plan to accept",
    );

    const all = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        String(i + 1),
        { status: "done" as const },
      ]),
    );
    rerenderTree(
      <PlanTree
        loop={loopOf(7, all, { status: "stopped" })}
        plan={planOf(7)}
      />,
    );
    expect(getAnnouncement("polite").text).toBe("Loop finished, 7 of 7 done");
  });

  it("announces what the loop decided for the person, masked", () => {
    const base = running();
    const { rerenderTree } = mount(<PlanTree loop={base} plan={planOf(7)} />);
    const decided = {
      ...base,
      autoDecisions: [
        {
          kind: "question",
          by: "system",
          source: "Questions: Permissive",
          text: "Auto-answered: Merge PR #7 as-is? -> Merge it",
          at: T0.toISOString(),
        },
      ],
    } as unknown as LoopState;
    rerenderTree(<PlanTree loop={decided} plan={planOf(7)} />);
    expect(getAnnouncement("polite").text).toBe(
      "Auto-answered: Merge PR #7 as-is? -> Merge it",
    );
  });
});
