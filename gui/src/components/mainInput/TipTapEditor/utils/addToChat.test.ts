import { describe, expect, it } from "vitest";
import {
  describeAddToChat,
  describeAddToChatRefusals,
  planAddToChat,
} from "./addToChat";

const both = { file: true, folder: true };

function chips(plan: ReturnType<typeof planAddToChat>) {
  return plan.content.filter((c) => c.type === "mention").map((c) => c.attrs);
}

describe("planAddToChat", () => {
  it("makes the same @file and @folder chips the @ list makes", () => {
    const plan = planAddToChat(
      {
        data: [
          { type: "file", fullPath: "file:///ws/a.ts", name: "a.ts" },
          { type: "folder", fullPath: "file:///ws/lib", name: "lib" },
        ],
      },
      undefined,
      both,
    );
    expect(chips(plan)).toEqual([
      {
        id: "file:///ws/a.ts",
        label: "a.ts",
        query: "file:///ws/a.ts",
        itemType: "file",
      },
      {
        id: "file:///ws/lib",
        label: "lib",
        query: "file:///ws/lib",
        itemType: "folder",
      },
    ]);
    // each chip is followed by a space
    expect(plan.content[1]).toEqual({ type: "text", text: " " });
    expect(describeAddToChat(plan)).toBe(
      "Added 1 file and 1 folder to the chat input.",
    );
  });

  it("does not add a chip that is already in the message, or the same item twice", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { itemType: "file", query: "file:///ws/a.ts" },
            },
          ],
        },
      ],
    };
    const plan = planAddToChat(
      {
        data: [
          { type: "file", fullPath: "file:///ws/a.ts", name: "a.ts" },
          { type: "file", fullPath: "file:///ws/b.ts", name: "b.ts" },
          { type: "file", fullPath: "file:///ws/b.ts", name: "b.ts" },
        ],
      },
      doc,
      both,
    );
    expect(chips(plan).map((c) => c?.query)).toEqual(["file:///ws/b.ts"]);
    expect(plan.duplicates).toBe(2);
    expect(describeAddToChat(plan)).toBe(
      "Added 1 file to the chat input. 2 items were already in the message.",
    );
  });

  it("refuses a folder when the folder provider is not configured", () => {
    const plan = planAddToChat(
      {
        data: [{ type: "folder", fullPath: "file:///ws/lib", name: "lib" }],
      },
      undefined,
      { file: true, folder: false },
    );
    expect(plan.content).toEqual([]);
    expect(plan.refusals).toEqual([{ name: "lib", reason: "no-provider" }]);
  });

  it("carries the host's refusals into the sentence", () => {
    const plan = planAddToChat(
      {
        data: [],
        refused: [
          { name: ".env", reason: "secret" },
          { name: "notes.md", reason: "outside-workspace" },
        ],
      },
      undefined,
      both,
    );
    expect(describeAddToChat(plan)).toBe(
      ".env looks like it holds secrets or keys, so it was not added. notes.md is outside the workspace, so it was not added.",
    );
    expect(describeAddToChatRefusals(plan)).toBe(describeAddToChat(plan));
  });

  it("names at most three refusals and counts the rest", () => {
    const refused = ["a", "b", "c", "d", "e"].map((name) => ({
      name,
      reason: "unsaved" as const,
    }));
    const text = describeAddToChat(
      planAddToChat({ data: [], refused }, undefined, both),
    );
    expect(text).toContain("c is not saved yet");
    expect(text).not.toContain("d is not saved yet");
    expect(text).toContain("2 more items were not added.");
  });

  it("has no refusal notice when nothing was refused", () => {
    const plan = planAddToChat({ data: [] }, undefined, both);
    expect(describeAddToChatRefusals(plan)).toBeNull();
    expect(describeAddToChat(plan)).toBe(
      "Nothing was added to the chat input.",
    );
  });
});
