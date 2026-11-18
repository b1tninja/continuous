import type { ModelDescription, SessionEnvironment } from "core";
import { runTerminalCommandTool } from "core/tools/definitions/runTerminalCommand";
import { describe, expect, it } from "vitest";
import { getEmptyRootState } from "../test/mockStore";
import {
  buildSubagentSystemMessage,
  newLocalSession,
  prepareSubagentRequests,
} from "./runSubagent";

const model: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};

const STRINGS = {
  systemLine: "<env>\nPlatform: Linux (linux, x64)\n</env>\nPOINTER",
  toolSentence: "Runs in bash (/bin/bash), PARENT SENTENCE.",
  firstMessageBlock: '<context name="environment">\nPARENT BLOCK\n</context>',
};

function stateWith(strings?: typeof STRINGS) {
  const base = getEmptyRootState();
  return {
    ...base,
    session: {
      ...base.session,
      environment: strings
        ? ({
            snapshot: {},
            detail: "standard",
            strings,
          } as unknown as SessionEnvironment)
        : undefined,
    },
  };
}

describe("a subagent is told what its parent was told (ENV17)", () => {
  it("the parent's system line and shell sentence, not a new gather", () => {
    const prepared = prepareSubagentRequests(
      stateWith(STRINGS) as never,
      model,
      [runTerminalCommandTool],
      "BASE",
    );
    expect(prepared.systemMessage).toBe(`BASE\n\n${STRINGS.systemLine}`);
    const tools = prepared.completionOptions.tools ?? [];
    expect(tools[0].function.description).toContain(STRINGS.toolSentence);
  });

  it("the parent's first-message block before the task, and no raw folder paths", () => {
    const local = newLocalSession("Find the bug.", STRINGS.firstMessageBlock);
    expect(local.history[0].message.content).toBe(
      `${STRINGS.firstMessageBlock}\n\nFind the bug.`,
    );
    const system = buildSubagentSystemMessage(
      { name: "explore", prompt: "" } as never,
      ["file:///home/zzcanaryuser/acme-api"],
      true,
    );
    expect(system).not.toContain("zzcanaryuser");
  });

  it("without a parent environment nothing changes", () => {
    const prepared = prepareSubagentRequests(
      stateWith() as never,
      model,
      [runTerminalCommandTool],
      "BASE",
    );
    expect(prepared.systemMessage).toBe("BASE");
    expect(newLocalSession("Task").history[0].message.content).toBe("Task");
  });
});
