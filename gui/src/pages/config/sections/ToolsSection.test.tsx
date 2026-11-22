import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import { ToolsSection } from "./ToolsSection";

// These two load their own settings from core; they have their own tests
vi.mock("./ShadowReviewControl", () => ({ ShadowReviewControl: () => null }));
vi.mock("./TerminalEnvironmentControl", () => ({
  TerminalEnvironmentControl: () => null,
}));

describe("the Tools tab", () => {
  it("keeps the built-in tools and points to the MCP servers tab", async () => {
    await renderWithProviders(<ToolsSection />);
    expect(screen.getByRole("heading", { name: "Tools" })).toBeDefined();
    const moved = screen.getByTestId("mcp-moved");
    expect(moved.textContent).toContain(
      "MCP servers have moved to their own tab.",
    );
    expect(
      within(moved)
        .getByRole("link", { name: "Open MCP servers" })
        .getAttribute("href"),
    ).toBe("/config?tab=mcp");
    // The list itself is gone from here
    expect(screen.queryByText("MCP Servers")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add MCP server" })).toBeNull();
  });
});
