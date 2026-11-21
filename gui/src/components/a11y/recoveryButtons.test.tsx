import { act, screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import type { ToolCallState } from "core";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { GroupedToolCallHeader } from "../../pages/gui/ToolCallDiv/GroupedToolCallHeader";
import { SimpleToolCallUI } from "../../pages/gui/ToolCallDiv/SimpleToolCallUI";
import { ToolCallDisplay } from "../../pages/gui/ToolCallDiv/ToolCallDisplay";
import { setConfigResult } from "../../redux/slices/configSlice";
import { setInlineErrorMessage } from "../../redux/slices/sessionSlice";
import { CONFIG_ROUTES } from "../../util/navigation";
import { renderWithProviders } from "../../util/test/render";
import { FatalErrorIndicator } from "../config/FatalErrorNotice";
import { History } from "../History";
import InlineErrorMessage from "../mainInput/InlineErrorMessage";

/** Presses Tab until `target` has focus; fails if Tab never gets there. */
async function tabTo(user: UserEvent, target: HTMLElement) {
  for (let i = 0; i < 40 && document.activeElement !== target; i++) {
    await user.tab();
  }
  expect(document.activeElement).toBe(target);
}

function isRealButton(el: HTMLElement) {
  expect(el.tagName).toBe("BUTTON");
  expect(el.getAttribute("type")).toBe("button");
}

function toolCall(outputs: number): ToolCallState {
  return {
    toolCallId: "call-1",
    toolCall: {
      id: "call-1",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    },
    status: "done",
    parsedArgs: {},
    output: Array.from({ length: outputs }, (_, i) => ({
      name: `result ${i}`,
      description: `result ${i}`,
      content: `content ${i}`,
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the fatal config error's ways out", () => {
  function Path() {
    const location = useLocation();
    return (
      <div data-testid="path">{`${location.pathname}${location.search}`}</div>
    );
  }

  async function setup() {
    const ideMessenger = new MockIdeMessenger();
    const post = vi.spyOn(ideMessenger, "post");
    const request = vi.spyOn(ideMessenger, "request");
    const view = await renderWithProviders(
      <>
        <FatalErrorIndicator />
        <Path />
      </>,
      { mockIdeMessenger: ideMessenger },
    );
    await act(async () => {
      view.store.dispatch(
        setConfigResult({
          config: undefined,
          errors: [{ fatal: true, message: "bad config" }],
          configLoadInterrupted: true,
        }),
      );
    });
    return { ...view, post, request };
  }

  it("Help, Reload and View are buttons reached with Tab and worked with Enter", async () => {
    const { user, post, request } = await setup();

    const help = screen.getByRole("button", { name: "Help" });
    isRealButton(help);
    await tabTo(user, help);
    await user.keyboard("{Enter}");
    expect(post).toHaveBeenCalledWith(
      "openUrl",
      "https://b1tninja.github.io/continuous/troubleshooting",
    );

    const view = screen.getByRole("button", { name: "View" });
    isRealButton(view);
    const reload = screen.getByRole("button", { name: "Reload" });
    isRealButton(reload);
    await tabTo(user, reload);
    await user.keyboard("{Enter}");
    expect(request).toHaveBeenCalledWith("config/refreshProfiles", {
      reason: "Clicked reload in fatal indicator",
    });

    // Reload is replaced by "Reloading..." and back, so find View again
    await tabTo(user, await screen.findByRole("button", { name: "View" }));
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("path").textContent).toBe(CONFIG_ROUTES.CONFIGS);
  });
});

describe("the context-window error's ways out", () => {
  it("Open config and Hide are buttons reached with Tab and worked with Enter", async () => {
    const ideMessenger = new MockIdeMessenger();
    const post = vi.spyOn(ideMessenger, "post");
    const { user, store } = await renderWithProviders(<InlineErrorMessage />, {
      mockIdeMessenger: ideMessenger,
    });
    await act(async () => {
      store.dispatch(setInlineErrorMessage("out-of-context"));
    });

    const open = screen.getByRole("button", { name: "Open config" });
    isRealButton(open);
    await tabTo(user, open);
    await user.keyboard("{Enter}");
    expect(post).toHaveBeenCalledWith("config/openProfile", {
      profileId: undefined,
    });

    const hide = screen.getByRole("button", { name: "Hide" });
    isRealButton(hide);
    await tabTo(user, hide);
    await user.keyboard("{Enter}");
    expect(store.getState().session.inlineErrorMessage).toBeUndefined();
    expect(screen.queryByTestId("context-window-error")).toBeNull();
  });
});

describe("History search", () => {
  it("the clear control is a named button reached with Tab and worked with Enter", async () => {
    const { user } = await renderWithProviders(<History />);
    const search = screen.getByPlaceholderText(
      "Search past sessions",
    ) as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    await user.click(search);
    await user.keyboard("abc");
    expect(search.value).toBe("abc");

    const clear = screen.getByRole("button", { name: "Clear search" });
    isRealButton(clear);
    await user.tab();
    expect(document.activeElement).toBe(clear);
    await user.keyboard("{Enter}");
    expect(search.value).toBe("");
    // Focus goes back to the box, since the button is gone
    expect(document.activeElement).toBe(search);
  });
});

describe("tool-call rows", () => {
  const tool = {
    type: "function" as const,
    displayTitle: "Read File",
    function: { name: "read_file" },
    group: "Built-In",
    readonly: true,
  };

  it("a row with several results is a disclosure button", async () => {
    const { user } = await renderWithProviders(
      <SimpleToolCallUI
        toolCallState={toolCall(2)}
        tool={tool}
        historyIndex={0}
      />,
    );
    const row = screen.getByTestId("context-items-peek");
    isRealButton(row);
    expect(row.textContent).toContain("Read File");
    expect(row.getAttribute("aria-expanded")).toBe("false");

    await tabTo(user, row);
    await user.keyboard("{Enter}");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard(" ");
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("a row with one result opens it from the keyboard", async () => {
    const ideMessenger = new MockIdeMessenger();
    const show = vi
      .spyOn(ideMessenger.ide, "showVirtualFile")
      .mockResolvedValue(undefined);
    const { user } = await renderWithProviders(
      <SimpleToolCallUI
        toolCallState={toolCall(1)}
        tool={tool}
        historyIndex={0}
      />,
      { mockIdeMessenger: ideMessenger },
    );
    const row = screen.getByTestId("context-items-peek");
    isRealButton(row);
    // Nothing expands, so it does not claim to
    expect(row.hasAttribute("aria-expanded")).toBe(false);

    await tabTo(user, row);
    await user.keyboard("{Enter}");
    expect(show).toHaveBeenCalledWith("result 0", "content 0");
  });

  it("a row with nothing to open is not a button", async () => {
    await renderWithProviders(
      <SimpleToolCallUI
        toolCallState={toolCall(0)}
        tool={tool}
        historyIndex={0}
      />,
    );
    expect(screen.getByTestId("context-items-peek").tagName).toBe("DIV");
  });

  it("a tool call's title row opens its result from the keyboard", async () => {
    const ideMessenger = new MockIdeMessenger();
    const show = vi
      .spyOn(ideMessenger.ide, "showVirtualFile")
      .mockResolvedValue(undefined);
    const { user } = await renderWithProviders(
      <ToolCallDisplay
        toolCallState={toolCall(1)}
        tool={tool}
        icon={<span />}
        historyIndex={0}
      >
        <div />
      </ToolCallDisplay>,
      { mockIdeMessenger: ideMessenger },
    );
    const row = screen.getByTestId("tool-call-title").closest("button")!;
    isRealButton(row);

    await tabTo(user, row);
    await user.keyboard("{Enter}");
    expect(show).toHaveBeenCalledWith("result 0", "content 0");
  });

  it("the grouped actions header is a disclosure button", async () => {
    function Group() {
      const [open, setOpen] = useState(true);
      const calls = [toolCall(0), toolCall(0)];
      return (
        <GroupedToolCallHeader
          toolCallStates={calls}
          activeCalls={calls}
          open={open}
          onToggle={() => setOpen(!open)}
        />
      );
    }
    const { user } = await renderWithProviders(<Group />);
    const header = screen.getByTestId("performing-actions");
    isRealButton(header);
    expect(header.textContent).toContain("2 actions");
    expect(header.getAttribute("aria-expanded")).toBe("true");

    await tabTo(user, header);
    await user.keyboard("{Enter}");
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });
});
