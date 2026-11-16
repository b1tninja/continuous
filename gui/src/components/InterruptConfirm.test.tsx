import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { BaseSessionMetadata, ChatHistoryItem, LoopState } from "core";
import { describe, expect, it, vi } from "vitest";
import { PaletteCommandListeners } from "../hooks/usePaletteCommandListeners";
import {
  newSession,
  setActive,
  setAllSessionMetadata,
} from "../redux/slices/sessionSlice";
import { setTabs } from "../redux/slices/tabsSlice";
import {
  askToStopResponse,
  confirmInterrupt,
  confirmSessionSwitch,
  selectRunningWork,
} from "../redux/thunks/interruptConfirm";
import type { RootState } from "../redux/store";
import { createMockStore, getEmptyRootState } from "../util/test/mockStore";
import { renderWithProviders } from "../util/test/render";
import { History } from "./History";
import { describeRunningWork, InterruptConfirm } from "./InterruptConfirm";
import { TabBar } from "./TabBar/TabBar";

const question = () => screen.queryByTestId("interrupt-confirm");
const loads = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([type]: unknown[]) => type === "history/load");

function storeWith(session: Record<string, unknown>) {
  const base = getEmptyRootState();
  const store = createMockStore({
    session: { ...base.session, ...session } as typeof base.session,
  });
  return store as Omit<typeof store, "getState"> & {
    getState: () => RootState;
  };
}

const pendingCall = (status: string): ChatHistoryItem =>
  ({
    message: { id: "a1", role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "t1",
        status,
        parsedArgs: {},
        toolCall: {
          id: "t1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      },
    ],
  }) as unknown as ChatHistoryItem;

describe("what counts as running work", () => {
  it("is nothing when idle", () => {
    expect(selectRunningWork(storeWith({}).getState())).toBeUndefined();
  });

  it("is a streaming reply, a call waiting for approval, a running tool or a running loop", () => {
    expect(
      selectRunningWork(storeWith({ isStreaming: true }).getState())?.streaming,
    ).toBe(true);
    expect(
      selectRunningWork(
        storeWith({ history: [pendingCall("generated")] }).getState(),
      )?.awaitingApproval,
    ).toBe(1);
    expect(
      selectRunningWork(
        storeWith({ history: [pendingCall("calling")] }).getState(),
      )?.running,
    ).toBe(1);
    expect(
      selectRunningWork(
        storeWith({ loop: { status: "running" } as LoopState }).getState(),
      )?.loop,
    ).toBe(true);
    expect(
      selectRunningWork(
        storeWith({ loop: { status: "stopped" } as LoopState }).getState(),
      ),
    ).toBeUndefined();
  });

  it("is named in the question", () => {
    expect(
      describeRunningWork({
        streaming: true,
        awaitingApproval: 0,
        running: 0,
        loop: true,
      }),
    ).toBe("The agent is still writing its reply, and a loop is running.");
    expect(
      describeRunningWork({
        streaming: false,
        awaitingApproval: 1,
        running: 0,
        loop: false,
      }),
    ).toBe("A tool call is waiting for your approval.");
  });
});

describe("the question's thunks", () => {
  it("a switch with nothing running goes ahead without asking", async () => {
    const store = storeWith({});
    expect(
      await store.dispatch(confirmSessionSwitch("newSession") as any).unwrap(),
    ).toBe(true);
    expect(store.getState().ui.interruptConfirm).toBeUndefined();
  });

  it("Stop with nothing to stop answers false without asking", async () => {
    const store = storeWith({});
    expect(await store.dispatch(askToStopResponse() as any).unwrap()).toBe(
      false,
    );
    expect(store.getState().ui.interruptConfirm).toBeUndefined();
  });

  it("asks one question at a time: a second ask while one is open is a no", async () => {
    const store = storeWith({ isStreaming: true });
    void store.dispatch(confirmInterrupt("newSession") as any);
    await waitFor(() =>
      expect(store.getState().ui.interruptConfirm?.action).toBe("newSession"),
    );
    expect(
      await store.dispatch(confirmInterrupt("newSession") as any).unwrap(),
    ).toBe(false);
  });
});

describe("the question on screen", () => {
  it("is an alertdialog with labelled buttons and their keys", async () => {
    const { store } = await renderWithProviders(<InterruptConfirm />);
    await act(async () => {
      store.dispatch(setActive());
      void store.dispatch(askToStopResponse());
    });
    const dialog = await screen.findByRole("alertdialog", {
      name: "Stop the response?",
    });
    expect(dialog).toHaveAccessibleDescription(
      /What it wrote so far is kept, and so is your unsent message/,
    );
    expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Enter",
    );
    expect(screen.getByRole("button", { name: "Keep going" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Escape",
    );
    expect(document.activeElement).toBe(dialog);
  });

  it("a click on Stop stops", async () => {
    const { store } = await renderWithProviders(<InterruptConfirm />);
    await act(async () => {
      store.dispatch(setActive());
      void store.dispatch(askToStopResponse());
    });
    await act(async () => {
      screen.getByRole("button", { name: "Stop" }).click();
    });
    await waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(false),
    );
    expect(question()).toBeNull();
  });

  it("Enter on the Keep going button keeps going", async () => {
    const { store, user } = await renderWithProviders(<InterruptConfirm />);
    await act(async () => {
      store.dispatch(setActive());
      void store.dispatch(askToStopResponse());
    });
    screen.getByRole("button", { name: "Keep going" }).focus();
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    await user.keyboard("{Enter}");
    expect(question()).toBeNull();
    expect(store.getState().session.isStreaming).toBe(true);
  });
});

describe("the Command Palette's Stop Response", () => {
  it("asks in the panel and answers that there was something to stop", async () => {
    const { store, ideMessenger } = await renderWithProviders(
      <>
        <PaletteCommandListeners />
        <InterruptConfirm />
      </>,
    );
    const respond = vi.spyOn(ideMessenger, "respond");
    await act(async () => {
      store.dispatch(setActive());
      ideMessenger.mockMessageToWebview("stopResponse", undefined);
    });
    await waitFor(() => expect(question()).toBeInTheDocument());
    expect(store.getState().session.isStreaming).toBe(true);
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(
        "stopResponse",
        true,
        expect.any(String),
      ),
    );
  });
});

describe("History and tabs over running work (NI1)", () => {
  const meta = (id: string, title: string): BaseSessionMetadata => ({
    sessionId: id,
    title,
    dateCreated: new Date().toString(),
    workspaceDirectory: "/tmp",
  });

  it("opening a History entry asks first and opens it only on yes", async () => {
    const { store, ideMessenger } = await renderWithProviders(
      <>
        <History />
        <InterruptConfirm floating />
      </>,
    );
    const request = vi.spyOn(ideMessenger, "request");
    await act(async () => {
      store.dispatch(setAllSessionMetadata([meta("other", "Other chat")]));
      store.dispatch(setActive());
    });
    await act(async () => {
      fireEvent.click(await screen.findByText("Other chat"));
    });
    await waitFor(() =>
      expect(question()?.getAttribute("data-action")).toBe("openSession"),
    );
    expect(loads(request)).toHaveLength(0);
    expect(store.getState().session.isStreaming).toBe(true);

    await act(async () => {
      screen.getByTestId("interrupt-confirm-yes").click();
    });
    await waitFor(() => expect(loads(request)).toHaveLength(1));
    expect(loads(request)[0][1]).toEqual({ id: "other" });
  });

  it("switching tabs asks first; Keep working stays", async () => {
    const { store, ideMessenger } = await renderWithProviders(
      <>
        <TabBar />
        <InterruptConfirm />
      </>,
    );
    const request = vi.spyOn(ideMessenger, "request");
    const current = store.getState().session.id;
    await act(async () => {
      store.dispatch(
        newSession({
          sessionId: current,
          title: "Now",
          workspaceDirectory: "",
          history: [
            {
              message: {
                id: "u",
                role: "user",
                content: "hi",
              } as ChatHistoryItem["message"],
              contextItems: [],
            },
          ],
        }),
      );
      store.dispatch(
        setTabs([
          { id: "t1", title: "Now", isActive: true, sessionId: current },
          { id: "t2", title: "Earlier", isActive: false, sessionId: "s-old" },
        ]),
      );
      store.dispatch(setActive());
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Earlier"));
    });
    await waitFor(() =>
      expect(question()?.getAttribute("data-action")).toBe("switchTab"),
    );
    await act(async () => {
      screen.getByTestId("interrupt-confirm-keep").click();
    });
    expect(loads(request)).toHaveLength(0);
    expect(store.getState().tabs.tabs.find((t) => t.isActive)?.id).toBe("t1");
    expect(store.getState().session.isStreaming).toBe(true);
  });
});
