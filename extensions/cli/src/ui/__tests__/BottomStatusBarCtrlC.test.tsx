import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BottomStatusBar,
  BottomStatusBarProps,
} from "../components/BottomStatusBar.js";

// Mock the index module functions
vi.mock("../../index.js", () => ({
  shouldShowExitMessage: vi.fn(() => false),
  setExitMessageCallback: vi.fn(),
}));

// Mock git utility functions
vi.mock("../../util/git.js", () => ({
  isGitRepo: vi.fn(() => false),
  getGitRemoteUrl: vi.fn(() => null),
  getGitBranch: vi.fn(() => null),
}));

describe("BottomStatusBar Ctrl+C message", () => {
  const defaultProps: BottomStatusBarProps = {
    currentMode: "normal" as const,
    remoteUrl: "github.com/user/repo",
    isRemoteMode: false,
    services: { model: { model: null } },
    navState: { currentScreen: "chat" },
    navigateTo: vi.fn(),
    closeCurrentScreen: vi.fn(),
    contextPercentage: undefined,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset mocks to default state
    const indexModule = (await vi.importMock("../../index.js")) as any;
    indexModule.shouldShowExitMessage.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows repo URL when not in exit message mode", async () => {
    const indexModule = (await vi.importMock("../../index.js")) as any;
    indexModule.shouldShowExitMessage.mockReturnValue(false);

    const { lastFrame } = render(<BottomStatusBar {...defaultProps} />);

    expect(lastFrame()).toContain("github.com/user/repo");
    expect(lastFrame()).not.toContain("ctrl+c to exit");
  });

  it("shows exit message when shouldShowExitMessage returns true", async () => {
    const indexModule = (await vi.importMock("../../index.js")) as any;
    indexModule.shouldShowExitMessage.mockReturnValue(true);

    const { lastFrame } = render(<BottomStatusBar {...defaultProps} />);

    expect(lastFrame()).toContain("ctrl+c to exit");
    expect(lastFrame()).not.toContain("github.com/user/repo");
  });

  it("shows the model and effort in use after a bullet separator (M7)", () => {
    const { lastFrame } = render(
      <BottomStatusBar
        {...defaultProps}
        services={{
          model: {
            model: null,
            inUse: {
              name: "o3",
              model: "o3",
              provider: "openai",
              effort: "high",
              reason: "use",
              use: "plan",
            },
          },
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\u2022 o3 (high)");
    expect(frame).not.toContain("\ufffd");
  });

  it("shows no model when none is recorded", () => {
    const { lastFrame } = render(<BottomStatusBar {...defaultProps} />);
    expect(lastFrame()).not.toContain("(high)");
  });

  it("registers exit message callback on mount", async () => {
    const indexModule = (await vi.importMock("../../index.js")) as any;

    render(<BottomStatusBar {...defaultProps} />);

    expect(indexModule.setExitMessageCallback).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });
});
