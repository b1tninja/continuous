import type { SubagentRunState } from "core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  peekInbox,
  registerSubagentRun,
  sendToSubagent,
  takeInbox,
} from "../../util/subagents/registry";
import { getAnnouncement, resetAnnouncer } from "../a11y/announcer";
import { SubagentMessages } from "./SubagentMessages";

const run = (over: Partial<SubagentRunState> = {}): SubagentRunState => ({
  agent: "explore",
  prompt: "look",
  status: "running",
  toolCalls: [],
  text: "",
  ...over,
});

let unregister: (() => void) | undefined;
const goLive = (id = "r1") => {
  unregister = registerSubagentRun(id, new AbortController());
};
const end = () =>
  act(() => {
    unregister?.();
    unregister = undefined;
  });

beforeEach(() => resetAnnouncer());
afterEach(() => {
  unregister?.();
  unregister = undefined;
  takeInbox("r1", "all");
});

const input = () => screen.getByRole("textbox", { name: "Message explore" });
const said = () => getAnnouncement("polite").text;

describe("SubagentMessages", () => {
  it("shows nothing for a run that is not live and was never messaged", () => {
    const { container } = render(
      <SubagentMessages runId="r1" name="explore" run={run()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("gives a live run a labelled input with its keys described; Send is unavailable until there is text", () => {
    goLive();
    render(<SubagentMessages runId="r1" name="explore" run={run()} />);
    const box = input();
    const hint = document.getElementById(box.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toContain("Send now: after its current tool");
    expect(hint?.textContent).toContain("Ctrl+Enter");
    const send = screen.getByRole("button", { name: "Send" });
    const now = screen.getByRole("button", { name: "Send now" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect((now as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "check b.ts" } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it("queues with Enter, steers with Ctrl+Enter, lists what waits in order, and says so", () => {
    goLive();
    render(<SubagentMessages runId="r1" name="explore" run={run()} />);
    fireEvent.change(input(), { target: { value: "first" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(said()).toBe("Queued for explore. It reads it before it finishes.");
    expect((input() as HTMLTextAreaElement).value).toBe("");

    fireEvent.change(input(), { target: { value: "second" } });
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    expect(said()).toBe(
      "Sent to explore. It reads it after its current tool calls.",
    );

    // Shift+Enter is a new line, not a send
    fireEvent.change(input(), { target: { value: "third" } });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(peekInbox("r1").map((m) => [m.text, m.steer])).toEqual([
      ["first", false],
      ["second", true],
    ]);

    const list = screen.getByRole("list", { name: "Queued for explore" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
    expect(items[0].textContent).toContain("before it finishes");
    expect(items[1].textContent).toContain("after its tool calls");
    // Send now is offered only on the one still waiting for the end
    expect(within(items[1]).queryByRole("button", { name: /^Send now/ })).toBe(
      null,
    );
    fireEvent.click(
      within(items[0]).getByRole("button", { name: "Send now: first" }),
    );
    expect(peekInbox("r1")[0].steer).toBe(true);
  });

  it("cancels a queued message before delivery, and drops a delivered one from the queue", () => {
    goLive();
    render(<SubagentMessages runId="r1" name="explore" run={run()} />);
    act(() => {
      sendToSubagent("r1", "oops", { steer: false });
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel: oops" }));
    expect(peekInbox("r1")).toHaveLength(0);
    expect(said()).toBe("Cancelled. It was not sent.");
    expect(screen.queryByRole("list", { name: "Queued for explore" })).toBe(
      null,
    );

    // Delivered by the run: it leaves the queue without a click
    act(() => {
      sendToSubagent("r1", "kept", { steer: true });
    });
    expect(screen.getByRole("button", { name: "Cancel: kept" })).toBeDefined();
    act(() => {
      takeInbox("r1", "steer");
    });
    expect(screen.queryByRole("button", { name: "Cancel: kept" })).toBe(null);
  });

  it("removes the input when the run ends and keeps what was delivered or not in a labelled list", async () => {
    goLive();
    const { rerender } = render(
      <SubagentMessages runId="r1" name="explore" run={run()} />,
    );
    expect(input()).toBeDefined();
    await end();
    rerender(
      <SubagentMessages
        runId="r1"
        name="explore"
        run={run({
          status: "completed",
          messages: [
            { text: "a", at: 1, delivered: true },
            { text: "b", at: 2, delivered: false },
          ],
        })}
      />,
    );
    expect(screen.queryByRole("textbox")).toBe(null);
    const list = screen.getByRole("list", { name: "Messages to explore" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual(["adelivered", "bnot delivered"]);
  });

  it("names the agent a message came from, queued or delivered, so it is not read as the person's", () => {
    goLive();
    act(() => {
      sendToSubagent("r1", "found it", {
        steer: true,
        from: { kind: "agent", name: "scout", runId: "r2" },
      });
    });
    render(
      <SubagentMessages
        runId="r1"
        name="explore"
        run={run({
          messages: [
            { text: "a.ts:3", at: 1, delivered: true, from: "scout" },
            { text: "mine", at: 2, delivered: true },
          ],
        })}
      />,
    );
    const queued = screen.getByRole("list", { name: "Queued for explore" });
    expect(within(queued).getByTestId("agent-message-from").textContent).toBe(
      "from scout:",
    );
    const sent = screen.getByRole("list", { name: "Messages to explore" });
    expect(
      within(sent)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual(["from scout:a.ts:3delivered", "minedelivered"]);
  });

  it("keeps a draft when Escape is pressed in it, so Escape does not leave the record", () => {
    goLive();
    let escaped = 0;
    render(
      <div
        onKeyDown={(e) => {
          if (e.key === "Escape") escaped++;
        }}
      >
        <SubagentMessages runId="r1" name="explore" run={run()} />
      </div>,
    );
    fireEvent.change(input(), { target: { value: "draft" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(escaped).toBe(0);
    expect((input() as HTMLTextAreaElement).value).toBe("draft");
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(escaped).toBe(1);
  });
});
