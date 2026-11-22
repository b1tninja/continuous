import { act, fireEvent, screen } from "@testing-library/react";
import type { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ReactNode, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import { StepContainerPreToolbar } from "../../components/StyledMarkdownPreview/StepContainerPreToolbar";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { clearKeptOpenState } from "../../hooks/useKeptOpenState";
import { newSession } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ChatTranscript, useScrollBox } from "./ChatTranscript";
import { ToolCallDiv } from "./ToolCallDiv";

afterEach(() => {
  vi.restoreAllMocks();
  clearKeptOpenState();
});

const ROW_PX = 100;

/** A 250px viewport over 100px rows, so most of a long list is unmounted. */
function installGeometry() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.chatScroll !== undefined ? 250 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.chatIndex !== undefined ? ROW_PX : 0;
    },
  );
}

/** The real transcript window, with `first` as row 0 of forty. */
function Transcript({ first }: { first: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollElement = useScrollBox(ref);
  const items = Array.from({ length: 40 }, (_, i) => `message-${i}`);
  return (
    <div ref={ref} data-chat-scroll="">
      <ChatTranscript
        scrollElement={scrollElement}
        items={items}
        stickToEnd={false}
        itemKey={(item) => item}
        renderItem={(item, index) =>
          index === 0 ? first : <span>{item}</span>
        }
      />
    </div>
  );
}

async function scrollTo(top: number) {
  const scroller = document.querySelector(
    "[data-chat-scroll]",
  ) as HTMLDivElement;
  await act(async () => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
  });
}

const firstRow = () => document.querySelector('[data-chat-index="0"]');

/** Scrolls far enough that row 0 is unmounted, then back to it. */
async function leaveAndReturn() {
  await scrollTo(30 * ROW_PX);
  expect(firstRow()).toBeNull();
  await scrollTo(0);
  expect(firstRow()).not.toBeNull();
}

async function renderTranscript(first: ReactNode) {
  installGeometry();
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(<Transcript first={first} />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  const rerender = async (next: ReactNode) => {
    await act(async () => {
      view.rerender(<Transcript first={next} />);
    });
  };
  return { ...view, rerender };
}

const CALL_ID = "call-1";

function subagentCall(): ToolCallState {
  const args = {
    agent: "Explore",
    description: "find foo",
    prompt: "Find every use of foo and report the files.",
  };
  return {
    toolCallId: CALL_ID,
    status: "calling",
    parsedArgs: args,
    toolCall: {
      id: CALL_ID,
      type: "function",
      function: {
        name: BuiltInToolNames.Subagent,
        arguments: JSON.stringify(args),
      },
    },
    subagent: {
      agent: "Explore",
      prompt: args.prompt,
      description: args.description,
      status: "running",
      toolCalls: [],
      text: "",
    },
  };
}

const toolRow = () => (
  <ToolCallDiv toolCallStates={[subagentCall()]} historyIndex={0} />
);
const promptToggle = () =>
  screen.getByTestId(`subagent-prompt-toggle-${CALL_ID}`);
const promptBody = () => screen.queryByTestId(`subagent-prompt-${CALL_ID}`);

const codeRow = (expanded?: boolean) => (
  <StepContainerPreToolbar
    codeBlockContent="const kept = 1;"
    language="ts"
    codeBlockIndex={0}
    isLastCodeblock
    codeBlockStreamId="stream-1"
    expanded={expanded}
  >
    <pre data-testid="code-body">const kept = 1;</pre>
  </StepContainerPreToolbar>
);
const codeBody = () => screen.queryByTestId("code-body");

const thinkingRow = (inProgress: boolean) => (
  <ThinkingBlockPeek
    content="Reading the parser"
    index={0}
    prevItem={null}
    inProgress={inProgress}
  />
);
const thinkingToggle = () => screen.getByTestId("thinking-block-peek");

describe("open or closed state across the transcript window", () => {
  it("keeps a tool call's details open after its row leaves and returns", async () => {
    await renderTranscript(toolRow());
    expect(promptBody()).toBeNull();

    fireEvent.click(promptToggle());
    expect(promptBody()).not.toBeNull();

    await leaveAndReturn();
    expect(promptBody()).not.toBeNull();
  });

  it("keeps a code block collapsed after its row leaves and returns", async () => {
    await renderTranscript(codeRow());
    expect(codeBody()).not.toBeNull();

    fireEvent.click(screen.getByTestId("toggle-codeblock"));
    expect(codeBody()).toBeNull();

    await leaveAndReturn();
    expect(codeBody()).toBeNull();
  });

  it("keeps a code block that starts collapsed open once the person opens it", async () => {
    await renderTranscript(codeRow(false));
    expect(codeBody()).toBeNull();

    fireEvent.click(screen.getByTestId("toggle-codeblock"));
    await leaveAndReturn();
    expect(codeBody()).not.toBeNull();
  });

  it("lets thinking follow the stream until the person chooses, then keeps the choice", async () => {
    const { rerender } = await renderTranscript(thinkingRow(true));
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "true");

    // Untouched, it folds when the answer starts, also after a remount
    await rerender(thinkingRow(false));
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "false");
    await leaveAndReturn();
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(thinkingToggle());
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "true");
    await leaveAndReturn();
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps thinking closed by hand while it streams", async () => {
    await renderTranscript(thinkingRow(true));
    fireEvent.click(thinkingToggle());
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "false");

    await leaveAndReturn();
    expect(thinkingToggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("starts a new session from the defaults", async () => {
    const { store } = await renderTranscript(toolRow());
    fireEvent.click(promptToggle());
    await leaveAndReturn();
    expect(promptBody()).not.toBeNull();

    await act(async () => {
      store.dispatch(newSession());
    });
    await leaveAndReturn();
    expect(promptBody()).toBeNull();
  });
});
