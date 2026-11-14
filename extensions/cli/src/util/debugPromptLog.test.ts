import { Command } from "commander";
import { DEBUG_PROMPT_LOG_ENV } from "core/util/debugPromptLog.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { addCommonOptions } from "../shared-options.js";

import { logCliDebugPrompt } from "./debugPromptLog.js";

const { append } = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("core/util/debugPromptLog.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  appendDebugPrompt: append,
}));

const saved = process.env[DEBUG_PROMPT_LOG_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[DEBUG_PROMPT_LOG_ENV];
  else process.env[DEBUG_PROMPT_LOG_ENV] = saved;
});

describe("--debug-prompt-log", () => {
  it("turns the debug prompt log on for the run, and is off without it", () => {
    delete process.env[DEBUG_PROMPT_LOG_ENV];
    const quiet = addCommonOptions(new Command()).action(() => {});
    quiet.parse([], { from: "user" });
    expect(process.env[DEBUG_PROMPT_LOG_ENV]).toBeUndefined();
    const on = addCommonOptions(new Command()).action(() => {});
    on.parse(["--debug-prompt-log"], { from: "user" });
    expect(process.env[DEBUG_PROMPT_LOG_ENV]).toBe("1");
  });

  it("records a request only while it is on", () => {
    append.mockClear();
    delete process.env[DEBUG_PROMPT_LOG_ENV];
    const messages = [{ role: "user", content: "hi" }];
    logCliDebugPrompt({ model: "m", messages });
    expect(append).not.toHaveBeenCalled();
    process.env[DEBUG_PROMPT_LOG_ENV] = "1";
    logCliDebugPrompt({ model: "m", messages });
    expect(append).toHaveBeenCalledWith({
      sessionId: undefined,
      model: "m",
      prompt: JSON.stringify(messages, undefined, 1),
    });
  });
});
