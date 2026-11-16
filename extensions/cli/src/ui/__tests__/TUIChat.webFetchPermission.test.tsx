import {
  resetWebGrantsForTests,
  webGrantsFor,
} from "core/tools/permissions/webGrants.js";
import { render } from "ink-testing-library";
import React from "react";
import { vi } from "vitest";

import { CLI_WEB_SESSION } from "../../permissions/webSession.js";
import { ToolPermissionSelector } from "../components/ToolPermissionSelector.js";

/** WB45: the ask for a Fetch offers the domain for this session, always, or No. */
describe("TUIChat - the Fetch ask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetWebGrantsForTests();
  });

  const renderFetch = (handleResponse: (...args: any[]) => void) =>
    render(
      <ToolPermissionSelector
        toolName="Fetch"
        toolArgs={{ url: "https://Docs.Example.com/guide" }}
        requestId="fetch-1"
        onResponse={handleResponse}
      />,
    );

  it("offers the three choices, naming the host", async () => {
    const { lastFrame } = renderFetch(vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Allow docs.example.com for this session");
    expect(frame).toContain("Always allow docs.example.com");
    expect(frame).toMatch(/\bNo\b/);
    expect(frame).not.toContain("Continue + always allow");
  });

  it("this session: approves and adds a session grant for the host", async () => {
    const handleResponse = vi.fn();
    const { stdin } = renderFetch(handleResponse);
    await vi.advanceTimersByTimeAsync(50);
    stdin.write("\r");
    await vi.advanceTimersByTimeAsync(50);
    expect(handleResponse).toHaveBeenCalledWith(
      "fetch-1",
      true,
      undefined,
      undefined,
    );
    expect(webGrantsFor(CLI_WEB_SESSION).isGranted("docs.example.com")).toBe(
      true,
    );
  });

  it("always: approves with a rule to save, and grants nothing for the session", async () => {
    const handleResponse = vi.fn();
    const { stdin } = renderFetch(handleResponse);
    await vi.advanceTimersByTimeAsync(50);
    stdin.write("a");
    await vi.advanceTimersByTimeAsync(50);
    expect(handleResponse).toHaveBeenCalledWith("fetch-1", true, true, false);
    expect(webGrantsFor(CLI_WEB_SESSION).isGranted("docs.example.com")).toBe(
      false,
    );
  });

  it("no: refuses", async () => {
    const handleResponse = vi.fn();
    const { stdin } = renderFetch(handleResponse);
    await vi.advanceTimersByTimeAsync(50);
    stdin.write("n");
    await vi.advanceTimersByTimeAsync(50);
    expect(handleResponse).toHaveBeenCalledWith("fetch-1", false, false, true);
    expect(webGrantsFor(CLI_WEB_SESSION).list().granted).toEqual([]);
  });
});
