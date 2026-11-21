import { describe, expect, it, vi } from "vitest";

import { MessageIde } from "./messageIde";
import { ReverseMessageIde } from "./reverseMessageIde";

/**
 * openFile carries one optional flag, preserveFocus, from core to the editor:
 * what the agent does on its own passes it, so that a file it created or an
 * edit it applied never takes the keyboard from whatever the person is typing.
 * A click on a link in the chat does not pass it, and still focuses.
 */
function wire() {
  const handlers = new Map<string, (msg: { data: any }) => any>();
  const reverse = new ReverseMessageIde(
    ((type: string, handler: (msg: { data: any }) => any) => {
      handlers.set(type, handler);
    }) as any,
    {
      openFile: vi.fn(async () => undefined),
    } as any,
  );
  void reverse;
  const sent: Array<{ type: string; data: any }> = [];
  const ide = new MessageIde(
    (async (type: string, data: unknown) => {
      sent.push({ type, data });
      // deliver it as the editor side would receive it
      return handlers.get(type)?.({ data });
    }) as any,
    (() => undefined) as any,
  );
  return { ide, sent, handlers };
}

describe("openFile and preserveFocus", () => {
  it("a plain openFile sends no flag, so a click still focuses", async () => {
    const { ide, sent } = wire();
    await ide.openFile("file:///a.ts");
    expect(sent[0]).toEqual({
      type: "openFile",
      data: { path: "file:///a.ts" },
    });
  });

  it("preserveFocus is sent when asked", async () => {
    const { ide, sent } = wire();
    await ide.openFile("file:///a.ts", { preserveFocus: true });
    expect(sent[0].data).toEqual({ path: "file:///a.ts", preserveFocus: true });
  });

  it("an explicit false is the same as not asking", async () => {
    const { ide, sent } = wire();
    await ide.openFile("file:///a.ts", { preserveFocus: false });
    expect(sent[0].data).toEqual({ path: "file:///a.ts" });
    expect("preserveFocus" in sent[0].data).toBe(false);
  });

  it("the flag reaches the editor side, and its absence stays absent", async () => {
    const opened: Array<[string, unknown]> = [];
    const handlers = new Map<string, (msg: { data: any }) => any>();
    new ReverseMessageIde(
      ((type: string, handler: (msg: { data: any }) => any) => {
        handlers.set(type, handler);
      }) as any,
      {
        openFile: async (path: string, options?: unknown) => {
          opened.push([path, options]);
        },
      } as any,
    );
    const open = handlers.get("openFile")!;
    await open({ data: { path: "file:///a.ts" } });
    await open({ data: { path: "file:///b.ts", preserveFocus: true } });
    await open({ data: { path: "file:///c.ts", preserveFocus: false } });
    expect(opened).toEqual([
      ["file:///a.ts", undefined],
      ["file:///b.ts", { preserveFocus: true }],
      ["file:///c.ts", undefined],
    ]);
  });
});
