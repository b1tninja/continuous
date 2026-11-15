import type { ToolCallState } from "core";
import { describe, expect, it, vi } from "vitest";
import { refuseWithheldCalls } from "./refuseWithheldCalls";

const call = (name: string): ToolCallState =>
  ({
    toolCallId: `id-${name}`,
    toolCall: { id: `id-${name}`, type: "function", function: { name } },
    parsedArgs: { q: 1 },
    status: "generated",
  }) as unknown as ToolCallState;

describe("refuseWithheldCalls (C88)", () => {
  it("refuses a call to a withheld tool, says why, and asks core to audit it", async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue({ status: "success" });
    const refused = await refuseWithheldCalls(
      dispatch,
      { request } as any,
      [call("srv_b"), call("read_file"), call("srv_gone")],
      [
        { name: "srv_b", gone: false },
        { name: "srv_gone", gone: true },
      ],
      { sessionId: "s1" },
    );
    expect(refused.map((c) => c.toolCallId)).toEqual([
      "id-srv_b",
      "id-srv_gone",
    ]);
    const outputs = dispatch.mock.calls
      .map(([a]) => a)
      .filter((a) => a.type === "session/updateToolCallOutput");
    expect(outputs[0].payload.contextItems[0].content).toMatch(
      /^srv_b is turned off for this session; the change applies when the prompt cache goes cold\./,
    );
    expect(outputs[1].payload.contextItems[0].content).toMatch(
      /srv_gone is no longer available in this session/,
    );
    expect(
      dispatch.mock.calls.filter(([a]) => a.type === "session/errorToolCall"),
    ).toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      "tools/evaluatePolicy",
      expect.objectContaining({
        toolName: "srv_b",
        basePolicy: "disabled",
        callId: "id-srv_b",
        sessionId: "s1",
        withheld:
          "srv_b is turned off for this session; the change applies when the prompt cache goes cold.",
      }),
    );
  });

  it("does nothing without withheld tools, and refuses even when the audit fails", async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error("down"));
    expect(
      await refuseWithheldCalls(
        dispatch,
        { request } as any,
        [call("a")],
        [],
        {},
      ),
    ).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    const refused = await refuseWithheldCalls(
      dispatch,
      { request } as any,
      [call("a")],
      [{ name: "a", gone: false }],
      {},
    );
    expect(refused).toHaveLength(1);
  });
});
