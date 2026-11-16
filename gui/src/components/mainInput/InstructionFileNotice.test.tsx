import { describe, expect, it, vi } from "vitest";
import type { InstructionFilesState } from "core/config/markdown/instructionFiles";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { InstructionFileNotice } from "./InstructionFileNotice";
import { act, screen } from "./noticeTestUtils";

async function setup(initial: InstructionFilesState) {
  const ideMessenger = new MockIdeMessenger();
  let state = initial;
  const handler = vi.fn(async (data: { load?: boolean }) => {
    if (data?.load) state = { withheld: [], notices: [] };
    return state;
  });
  ideMessenger.responseHandlers["instructionFiles/state"] = handler;
  const store = setupStore({ ideMessenger });
  await act(async () => {
    await renderWithProviders(<InstructionFileNotice />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
  });
  return { handler };
}

describe("InstructionFileNotice", () => {
  it("shows nothing when the host has nothing to say", async () => {
    await setup({ withheld: [], notices: [] });
    expect(screen.queryByTestId("instruction-file-notice")).toBeNull();
  });

  it("offers Load for an AGENTS.md withheld in Restricted Mode", async () => {
    const { handler } = await setup({
      withheld: ["file:///ws/AGENTS.md"],
      notices: [],
    });
    expect(
      screen.getByText(/Restricted Mode\), so AGENTS\.md was not read/),
    ).toBeTruthy();
    await act(async () => {
      screen.getByTestId("instruction-file-load").click();
    });
    expect(handler).toHaveBeenLastCalledWith({ load: true });
    expect(screen.queryByTestId("instruction-file-notice")).toBeNull();
  });

  it("shows each notice with the file named, and dismisses", async () => {
    await setup({
      withheld: [],
      notices: [
        {
          kind: "hidden-characters",
          file: "file:///ws/AGENTS.md",
          name: "AGENTS.md",
          message: "AGENTS.md: removed 2 hidden characters on lines 2, 3.",
        },
        {
          kind: "cut",
          file: "file:///ws/CLAUDE.md",
          name: "CLAUDE.md",
          message: "CLAUDE.md is 40 KiB, over the 32 KiB limit.",
        },
      ],
    });
    expect(
      screen.getByTestId("instruction-file-hidden-characters"),
    ).toBeTruthy();
    expect(screen.getByText("Open CLAUDE.md")).toBeTruthy();
    await act(async () => {
      screen.getByTestId("instruction-file-notice-dismiss").click();
    });
    expect(screen.queryByTestId("instruction-file-notice")).toBeNull();
  });
});
