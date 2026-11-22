import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  fieldFor,
  type NotSetContext,
} from "core/config/modelEdit/modelEditFields";
import {
  resolvedValue,
  type ModelLayers,
} from "core/config/modelEdit/valueState";
import { describe, expect, it, vi } from "vitest";
import { ValueState } from "./ValueState";

const context: NotSetContext = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  local: false,
};
const account = {
  name: "work",
  provider: "anthropic",
  requestOptions: { timeout: 300 },
};
const layers = (entry: Record<string, unknown> = {}): ModelLayers => ({
  entry: {
    name: "m",
    connection: "work",
    model: "claude-sonnet-4-6",
    ...entry,
  },
  entryFile: "config.yaml",
  account,
  accountFile: "file:///providers.yaml",
});
const state = (key: string, entry?: Record<string, unknown>) =>
  resolvedValue(fieldFor(key.split("."))!, layers(entry), context);

describe("ValueState, wide (a line under a control)", () => {
  it("a value the person set: Set by you, with a Reset button that removes it", async () => {
    const onReset = vi.fn();
    render(
      <ValueState
        state={state("requestOptions.connectTimeout", {
          requestOptions: { connectTimeout: 45 },
        })}
        label="Connect timeout"
        onReset={onReset}
        onGo={vi.fn()}
      />,
    );
    expect(screen.getByText("Set by you: 45")).toBeTruthy();
    const reset = screen.getByRole("button", { name: "Reset Connect timeout" });
    expect(reset.tagName).toBe("BUTTON");
    expect(reset).toHaveTextContent("Reset");
    await userEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Go to/ })).toBeNull();
  });

  it("a key nobody set: Not set, with what happens then, and no button", () => {
    const onReset = vi.fn();
    render(
      <ValueState
        state={state("requestOptions.connectTimeout")}
        label="Connect timeout"
        onReset={onReset}
      />,
    );
    expect(screen.getByText("Not set: 10 s")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an inherited value names its source and offers to go there", async () => {
    const onGo = vi.fn();
    render(
      <ValueState
        state={state("requestOptions.timeout")}
        label="Request timeout"
        onReset={vi.fn()}
        onGo={onGo}
      />,
    );
    expect(screen.getByText("Not set: 300 from the account work")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Go to account for Request timeout" }),
    );
    expect(onGo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("shows the source without a button when there is nowhere to go", () => {
    render(
      <ValueState
        state={state("requestOptions.timeout")}
        label="Request timeout"
      />,
    );
    expect(screen.getByText("Not set: 300 from the account work")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives the control a description to point at", () => {
    render(
      <>
        <input aria-label="Top P" aria-describedby="s" />
        <ValueState
          id="s"
          state={state("defaultCompletionOptions.topP")}
          label="Top P"
        />
      </>,
    );
    expect(screen.getByLabelText("Top P")).toHaveAccessibleDescription(
      "Not set: not sent, the provider decides",
    );
  });
});

describe("ValueState, narrow (one line)", () => {
  it("name, value, state, Reset", async () => {
    const onReset = vi.fn();
    render(
      <ValueState
        form="narrow"
        testId="row"
        state={state("requestOptions.connectTimeout", {
          requestOptions: { connectTimeout: 45 },
        })}
        label="Connect timeout"
        onReset={onReset}
      />,
    );
    expect(screen.getByTestId("row")).toHaveTextContent(
      /^Connect timeout\s*45\s*set by you\s*Reset$/,
    );
    await userEvent.click(screen.getByRole("button", { name: /Reset/ }));
    expect(onReset).toHaveBeenCalled();
  });

  it("name, what happens, not set", () => {
    render(
      <ValueState
        form="narrow"
        testId="row"
        state={state("requestOptions.connectTimeout")}
        label="Connect timeout"
      />,
    );
    expect(screen.getByTestId("row")).toHaveTextContent(
      /^Connect timeout\s*10 s\s*not set$/,
    );
  });

  it("an inherited value: the value, its source, Go", () => {
    render(
      <ValueState
        form="narrow"
        testId="row"
        state={state("requestOptions.timeout")}
        label="Request timeout"
        onGo={vi.fn()}
        onSet={vi.fn()}
      />,
    );
    expect(screen.getByTestId("row")).toHaveTextContent(
      /^Request timeout\s*300\s*account work\s*Go to account$/,
    );
  });

  it("offers Set when there is nothing to reset or go to", async () => {
    const onSet = vi.fn();
    render(
      <ValueState
        form="narrow"
        state={state("defaultCompletionOptions.topP")}
        label="Top P"
        onSet={onSet}
        onReset={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Set Top P" }));
    expect(onSet).toHaveBeenCalled();
  });
});
