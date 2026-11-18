import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import {
  newSession,
  setActive,
  setInactive,
  updateHistoryItemAtIndex,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { announce, resetAnnouncer } from "./announcer";
import { ChatAnnouncer } from "./ChatAnnouncer";

const polite = () => screen.getByTestId("live-region-polite");
const assertive = () => screen.getByTestId("live-region-assertive");

const toolCall = (status: string, command = "npm test") =>
  ({
    toolCallId: "t1",
    toolCall: {
      id: "t1",
      type: "function",
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    parsedArgs: { command },
    status,
  }) as any;

const reply = (content: string) =>
  ({
    index: 1,
    updates: { message: { role: "assistant", content } },
  }) as any;

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<ChatAnnouncer />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(updateConfig({ ...EMPTY_CONFIG }));
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          { message: { role: "user", content: "hi" }, contextItems: [] },
          { message: { role: "assistant", content: "" }, contextItems: [] },
        ],
      } as any),
    );
  });
  return store;
}

describe("live regions", () => {
  beforeEach(() => resetAnnouncer());

  it("has a polite status region and an assertive alert region, both always present", async () => {
    await setup();
    expect(polite().getAttribute("aria-live")).toBe("polite");
    expect(polite().getAttribute("role")).toBe("status");
    expect(assertive().getAttribute("aria-live")).toBe("assertive");
    expect(assertive().getAttribute("role")).toBe("alert");
  });

  it("re-reads the same sentence announced twice", async () => {
    await setup();
    await act(async () => announce("Same"));
    const first = polite().firstElementChild;
    await act(async () => announce("Same"));
    expect(polite().textContent).toBe("Same");
    expect(polite().firstElementChild).not.toBe(first);
  });

  it("announces that the assistant is responding once, not per token", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setActive());
    });
    expect(polite().textContent).toBe("Assistant is responding");
    const node = polite().firstElementChild;
    for (const text of ["a", "ab", "abc"]) {
      await act(async () => {
        store.dispatch(updateHistoryItemAtIndex(reply(text)));
      });
    }
    expect(polite().firstElementChild).toBe(node);
    expect(polite().textContent).toBe("Assistant is responding");
  });

  it("announces the first 200 characters of the reply when it ends", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setActive());
    });
    await act(async () => {
      store.dispatch(updateHistoryItemAtIndex(reply("word ".repeat(100))));
      store.dispatch(setInactive());
    });
    const text = polite().textContent ?? "";
    expect(text.startsWith("Assistant replied: word word")).toBe(true);
    expect(text.length).toBeLessThan(240);
    expect(text.endsWith("...")).toBe(true);
  });

  it("announces approval assertively with secrets masked, then state changes politely", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(
        updateHistoryItemAtIndex({
          index: 1,
          updates: {
            toolCallStates: [
              toolCall(
                "generated",
                "API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 npm publish",
              ),
            ],
          },
        } as any),
      );
    });
    const said = assertive().textContent ?? "";
    expect(said).toContain("Approval needed:");
    expect(said).toContain("npm publish");
    expect(said).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");

    await act(async () => {
      store.dispatch(
        updateHistoryItemAtIndex({
          index: 1,
          updates: { toolCallStates: [toolCall("done")] },
        } as any),
      );
    });
    expect(polite().textContent).toBe("run_terminal_command finished");
  });

  it("does not read out the finished tool calls of a session that was just loaded", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(
        newSession({
          sessionId: "other",
          title: "t",
          workspaceDirectory: "",
          history: [
            {
              message: { role: "assistant", content: "" },
              contextItems: [],
              toolCallStates: [toolCall("done")],
            },
          ],
        } as any),
      );
    });
    expect(polite().textContent).toBe("");
  });
});
