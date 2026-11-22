import { Tool, ToolCallState } from "core";
import { ContinueErrorReason } from "core/util/errors";
import { describe, expect, it } from "vitest";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { AppThunkDispatch, RootState } from "../store";
import { preprocessToolCalls } from "./preprocessToolCallArgs";
import { resolveUnknownToolCalls } from "./resolveUnknownToolCalls";

function tool(name: string, required: string[] = []): Tool {
  return {
    type: "function",
    displayTitle: name,
    readonly: true,
    group: "Built-In",
    function: {
      name,
      description: name,
      parameters: {
        type: "object",
        required,
        properties: Object.fromEntries(
          required.map((p) => [p, { type: "string" }]),
        ),
      },
    },
  };
}

const OFFERED = [
  tool("read_file", ["filepath"]),
  tool("ls"),
  tool("run_terminal_command", ["command"]),
];
// Hidden by the mode, or turned off: not offered, but a tool all the same
const KNOWN = [...OFFERED, tool("create_new_file", ["filepath", "contents"])];

function storeWithCall(name: string, args: Record<string, unknown>) {
  const state = getEmptyRootState();
  const toolCall = {
    id: "c1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
  state.session.history = [
    { message: { id: "u1", role: "user", content: "Go" }, contextItems: [] },
    {
      message: {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
      },
      contextItems: [],
      toolCallStates: [
        {
          toolCallId: "c1",
          toolCall: structuredClone(toolCall),
          status: "generated",
          parsedArgs: args,
        },
      ],
    },
  ];
  return createMockStore(state);
}

function resolved(name: string, args: Record<string, unknown>) {
  const store = storeWithCall(name, args);
  const before = (store.getState() as RootState).session.history[1]
    .toolCallStates!;
  const result = resolveUnknownToolCalls(
    store.dispatch as AppThunkDispatch,
    before,
    { offered: OFFERED, known: KNOWN },
  );
  const item = (store.getState() as RootState).session.history[1];
  return { result, call: item.toolCallStates![0], message: item.message };
}

describe("resolveUnknownToolCalls", () => {
  it("runs the CLI's Read as read_file: the call and the assistant message both become read_file", () => {
    const { result, call, message } = resolved("Read", { filepath: "a.ts" });
    expect(result.renamed).toHaveLength(1);
    expect(call.status).toBe("generated");
    expect(call.output).toBeUndefined();
    expect(call.toolCall.function.name).toBe("read_file");
    expect(call.parsedArgs).toEqual({ filepath: "a.ts" });
    expect(call.tool?.function.name).toBe("read_file");
    expect(
      message.role === "assistant" && message.toolCalls?.[0].function,
    ).toEqual({ name: "read_file", arguments: '{"filepath":"a.ts"}' });
  });

  it("answers any other wrong name with the tools on offer, and does not call it invalid arguments", () => {
    const { result, call } = resolved("open_file", { path: "a.ts" });
    expect(result.unknown).toHaveLength(1);
    expect(call.status).toBe("errored");
    expect(call.output?.[0].content).toBe(
      "There is no tool named open_file. The tools available are: read_file, ls, run_terminal_command.",
    );
    expect(call.output?.[0].content).not.toMatch(/arguments were invalid/);
  });

  it("gives the list when the alias would change what an argument means", () => {
    const { call } = resolved("Bash", { command: "ls", timeout: 600 });
    expect(call.status).toBe("errored");
    expect(call.output?.[0].content).toMatch(/^There is no tool named Bash\./);
  });

  it("leaves a real tool alone, offered or not", () => {
    for (const name of ["read_file", "create_new_file"]) {
      const { result, call } = resolved(name, { filepath: "a.ts" });
      expect(result).toEqual({ renamed: [], unknown: [] });
      expect(call.status).toBe("generated");
      expect(call.toolCall.function.name).toBe(name);
    }
  });

  it("judges no name when the session has no tool list to check it against", () => {
    const store = storeWithCall("Read", { filepath: "a.ts" });
    const calls = (store.getState() as RootState).session.history[1]
      .toolCallStates!;
    expect(
      resolveUnknownToolCalls(store.dispatch as AppThunkDispatch, calls, {
        offered: [],
        known: [],
      }),
    ).toEqual({ renamed: [], unknown: [] });
    expect(
      (store.getState() as RootState).session.history[1].toolCallStates![0]
        .status,
    ).toBe("generated");
  });
});

describe("a name core does not know, when it gets that far", () => {
  it("is reported in core's words, not as invalid arguments", async () => {
    const actions: { type: string; payload: any }[] = [];
    const dispatch = ((action: { type: string; payload: any }) => {
      actions.push(action);
      return action;
    }) as unknown as AppThunkDispatch;
    const ideMessenger = {
      request: async () => ({
        status: "success",
        content: {
          errorReason: ContinueErrorReason.ToolNotFound,
          errorMessage:
            "There is no tool named gone_tool. The tools available are: read_file.",
        },
      }),
    } as unknown as IIdeMessenger;
    const call: ToolCallState = {
      toolCallId: "c1",
      toolCall: {
        id: "c1",
        type: "function",
        function: { name: "gone_tool", arguments: "{}" },
      },
      status: "generated",
      parsedArgs: {},
    };
    await preprocessToolCalls(dispatch, ideMessenger, [call]);
    expect(
      actions.find((a) => a.type.endsWith("updateToolCallOutput"))?.payload
        .contextItems[0].content,
    ).toBe(
      "There is no tool named gone_tool. The tools available are: read_file.",
    );
  });
});
