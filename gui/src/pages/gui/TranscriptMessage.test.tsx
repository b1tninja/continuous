import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptMessage, messageAuthorLabel } from "./TranscriptMessage";

describe("TranscriptMessage", () => {
  it("names a user message You and an assistant message Assistant", () => {
    render(
      <>
        <TranscriptMessage role="user" minHeight={0}>
          hello
        </TranscriptMessage>
        <TranscriptMessage role="assistant" minHeight={0}>
          hi there
        </TranscriptMessage>
      </>,
    );
    expect(screen.getByRole("article", { name: "You" }).textContent).toBe(
      "hello",
    );
    expect(screen.getByRole("article", { name: "Assistant" }).textContent).toBe(
      "hi there",
    );
  });

  it("does not make an article of a role that renders nothing visible", () => {
    render(
      <TranscriptMessage role="tool" minHeight={0}>
        {null}
      </TranscriptMessage>,
    );
    expect(screen.queryByRole("article")).toBeNull();
    expect(messageAuthorLabel("tool")).toBeUndefined();
  });

  it("is not a log and has no live region", () => {
    const { container } = render(
      <TranscriptMessage role="assistant" minHeight={0}>
        text
      </TranscriptMessage>,
    );
    expect(container.querySelector("[role=log]")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});
