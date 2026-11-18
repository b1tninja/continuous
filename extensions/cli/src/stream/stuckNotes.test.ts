import type { ChatHistoryItem, ToolStatus } from "core/index.js";
import {
  decisionDraft,
  outcomeDraft,
} from "core/tools/permissions/audit/record.js";
import { STUCK_NOTE_MARK } from "core/util/stuckNotes.js";
import { afterEach, describe, expect, it } from "vitest";

import { stuckNoteForHistory, stuckNotesEnabled } from "./stuckNotes.js";

function item(
  name: string,
  args: Record<string, unknown>,
  output: string,
  status: ToolStatus,
  id: string,
): ChatHistoryItem {
  return {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall: {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
        status,
        parsedArgs: args,
        output: [{ content: output, name: "Tool Result", description: "" }],
      },
    ],
  } as ChatHistoryItem;
}

const failing = (command: string, id: string) =>
  item("Bash", { command }, "Error: Cannot find module 'x'", "errored", id);

describe("stuckNoteForHistory", () => {
  afterEach(() => {
    delete process.env.CONTINUE_CLI_DISABLE_STUCK_NOTES;
  });

  const stuck = [
    failing("npm test --silent", "1"),
    failing("npm test --verbose", "2"),
  ];

  it("gives a note once a signal reaches note", () => {
    expect(stuckNoteForHistory(stuck.slice(0, 1))).toBeUndefined();
    expect(stuckNoteForHistory(stuck)).toContain("same error");
  });

  it("ignores a note already appended to a result", () => {
    const noted = stuck.map((h, i) => {
      const copy = structuredClone(h);
      copy.toolCallStates![0].output![0].content += `${STUCK_NOTE_MARK}old ${i}`;
      return copy;
    });
    expect(stuckNoteForHistory(noted)).toBe(stuckNoteForHistory(stuck));
  });

  it("is quiet for a healthy history", () => {
    const h = [
      item("Read", { path: "a.ts" }, "a", "done", "1"),
      item("Read", { path: "b.ts" }, "b", "done", "2"),
    ];
    expect(stuckNoteForHistory(h)).toBeUndefined();
  });

  it("can be turned off", () => {
    process.env.CONTINUE_CLI_DISABLE_STUCK_NOTES = "1";
    expect(stuckNotesEnabled()).toBe(false);
    expect(stuckNoteForHistory(stuck)).toBeUndefined();
  });
});

describe("stuckNoteForHistory: an agent that is not the main one", () => {
  const sub = { id: "sub-c9", kind: "subagent" as const, role: "Explore" };
  const records = (agent: typeof sub | undefined) =>
    [1, 2].flatMap((turn) => {
      const callId = `c${turn}`;
      const base = { session: "s", turn, callId, tool: "Bash", agent };
      return [
        decisionDraft({
          ...base,
          args: JSON.stringify({ command: `npm test --v${turn}` }),
          policy: "allow",
          by: "rules",
        }),
        outcomeDraft({
          ...base,
          ran: true,
          exit: 1,
          output: "",
          error: "Error: Cannot find module 'x'",
        }),
      ].map((draft, i) => ({ ...draft, seq: turn * 2 + i }) as never);
    });
  const healthy = [item("Read", { path: "a.ts" }, "a", "done", "1")];
  const mainStuck = [
    failing("npm test --silent", "1"),
    failing("npm test --verbose", "2"),
  ];

  it("names the agent when its own steps repeat and the main agent's do not", () => {
    const note = stuckNoteForHistory(healthy, undefined, () => records(sub));
    expect(note).toContain("Agent Explore (sub-c9) (not the main agent)");
  });

  it("keeps the main agent's own note first", () => {
    expect(
      stuckNoteForHistory(mainStuck, undefined, () => records(sub)),
    ).toContain("same error");
    expect(
      stuckNoteForHistory(mainStuck, undefined, () => records(sub)),
    ).not.toContain("not the main agent");
  });

  it("says nothing for the main agent's records, or when the audit cannot be read", () => {
    expect(
      stuckNoteForHistory(healthy, undefined, () => records(undefined)),
    ).toBeUndefined();
    expect(
      stuckNoteForHistory(healthy, undefined, () => {
        throw new Error("no audit");
      }),
    ).toBeUndefined();
  });
});
