import { Tool, ToolCallState } from "core";
import { resolveToolAlias, unknownToolResult } from "core/tools/unknownTool";
import {
  errorToolCall,
  renameToolCall,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { AppThunkDispatch } from "../store";

/**
 * A call to a name no tool answers to. It used to reach core, which threw
 * "Tool X not found", and the result called that invalid arguments. Here the
 * other surface's name for a tool on offer (`Read` for `read_file`) becomes a
 * call to that tool, which the role check, the argument checks and the
 * person's rules then decide like any other. Any other name is answered with
 * the tools on offer, in the order the request listed them.
 *
 * `known` is every tool the session has, offered or not: a tool the mode
 * hides or the person turned off has a refusal of its own. With no tool list
 * at all there is nothing to check a name against, and core answers.
 */
export function resolveUnknownToolCalls(
  dispatch: AppThunkDispatch,
  generatedToolCalls: ToolCallState[],
  context: { offered: Tool[]; known: Tool[] },
): { renamed: ToolCallState[]; unknown: ToolCallState[] } {
  const renamed: ToolCallState[] = [];
  const unknown: ToolCallState[] = [];
  const offeredNames = context.offered.map((t) => t.function.name);
  const knownNames = new Set([
    ...offeredNames,
    ...context.known.map((t) => t.function.name),
  ]);
  if (knownNames.size === 0) return { renamed, unknown };
  for (const call of generatedToolCalls) {
    const name = call.toolCall.function.name;
    if (knownNames.has(name)) continue;
    const alias = resolveToolAlias(
      name,
      call.parsedArgs,
      context.offered.map((t) => ({
        name: t.function.name,
        required: t.function.parameters?.required,
      })),
    );
    if (alias) {
      renamed.push(call);
      dispatch(
        renameToolCall({
          toolCallId: call.toolCallId,
          name: alias.name,
          args: alias.args,
          tool: context.offered.find((t) => t.function.name === alias.name),
        }),
      );
      continue;
    }
    unknown.push(call);
    dispatch(errorToolCall({ toolCallId: call.toolCallId }));
    dispatch(
      updateToolCallOutput({
        toolCallId: call.toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Unknown tool",
            description: `There is no tool named ${name}`,
            content: unknownToolResult(name, offeredNames),
            hidden: false,
          },
        ],
      }),
    );
  }
  return { renamed, unknown };
}
