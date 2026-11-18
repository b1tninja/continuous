import { render } from "ink-testing-library";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const size = vi.hoisted(() => ({ columns: 80, rows: 24 }));
vi.mock("../hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ ...size, isResizing: false }),
}));

vi.mock("../../util/git.js", () => ({
  isGitRepo: vi.fn(() => true),
  getGitRemoteUrl: vi.fn(() => "https://github.com/owner/project.git"),
  getGitBranch: vi.fn(() => "feature"),
}));

import * as git from "../../util/git.js";

import { ResponsiveRepoDisplay } from "./ResponsiveRepoDisplay.js";

const gitCalls = () =>
  vi.mocked(git.isGitRepo).mock.calls.length +
  vi.mocked(git.getGitRemoteUrl).mock.calls.length +
  vi.mocked(git.getGitBranch).mock.calls.length;

describe("ResponsiveRepoDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    size.columns = 80;
  });

  it("reads git once and only re-lays out the text on resize", () => {
    const { lastFrame, rerender } = render(<ResponsiveRepoDisplay />);
    expect(lastFrame()).toContain("owner/project ⊦feature");
    const afterMount = gitCalls();
    expect(afterMount).toBe(3);

    // Narrow enough that only the branch fits, then wide again
    for (const columns of [30, 20, 16, 120]) {
      size.columns = columns;
      rerender(<ResponsiveRepoDisplay />);
    }
    expect(gitCalls()).toBe(afterMount);

    size.columns = 16;
    rerender(<ResponsiveRepoDisplay />);
    expect(lastFrame()).toContain("feature");
    expect(lastFrame()).not.toContain("owner/project");
  });

  it("reads git again when the remote it is given changes", () => {
    const { lastFrame, rerender } = render(
      <ResponsiveRepoDisplay remoteUrl="https://github.com/a/one.git" />,
    );
    const afterMount = gitCalls();
    rerender(
      <ResponsiveRepoDisplay remoteUrl="https://github.com/b/two.git" />,
    );
    expect(gitCalls()).toBeGreaterThan(afterMount);
    expect(lastFrame()).toContain("b/two");
  });
});
