import { describe, expect, it, vi } from "vitest";

import { handleSlashCommands } from "./slashCommands.js";
import { processSlashCommandResult } from "./ui/hooks/useChat.helpers.js";

vi.mock("./session.js");

/* V13: `/export --json` opens the picker whose writer scrubs the session;
   `--raw` reaches that writer. */

function opened(result: any) {
  const onShowExportSelector = vi.fn();
  processSlashCommandResult({
    result,
    chatHistory: [],
    setChatHistory: vi.fn(),
    onShowConfigSelector: vi.fn(),
    onShowExportSelector,
  });
  return onShowExportSelector;
}

describe("/export --json [--raw]", () => {
  it("opens the export picker, scrubbed by default", async () => {
    const result = await handleSlashCommands("/export --json", {} as any);
    expect(result?.openExportSelector).toBe(true);
    expect(opened(result)).toHaveBeenCalledWith(undefined);
  });

  it("--raw asks the picker for the session as it is", async () => {
    const result = await handleSlashCommands("/export --json --raw", {} as any);
    expect(result?.openExportSelector).toEqual({ raw: true });
    expect(opened(result)).toHaveBeenCalledWith({ raw: true });
  });
});
