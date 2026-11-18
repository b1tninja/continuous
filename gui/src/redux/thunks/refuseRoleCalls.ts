import { MessageModes, Tool, ToolCallState } from "core";
import { ideToolRef } from "core/tools/roleToolRefs";
import { roleForMode, roleRefusal } from "core/tools/roleTools";
import { errorToolCall, updateToolCallOutput } from "../slices/sessionSlice";
import { AppThunkDispatch } from "../store";

/**
 * A call to a tool the mode's role may not use is not run, whatever the model
 * was offered: it can emit the name of a hidden tool, by hallucination or
 * because a tool result steered it there. The role table (core/tools/roleTools)
 * is checked a second time here, at execution; it only ever refuses, and the
 * permission engine still decides every call this lets through.
 */
export function refuseRoleCalls(
  dispatch: AppThunkDispatch,
  generatedToolCalls: ToolCallState[],
  context: {
    mode: MessageModes | undefined;
    tools: Tool[];
    planMcpTools?: string[];
    trustedMcpServers?: string[];
    /** `background.mcpTools`: what a background run may use (TR25) */
    backgroundMcpTools?: string[];
    /** Tool use is IDGAF: a tool waiting for approval runs (TR4) */
    approvalWaived?: boolean;
  },
): ToolCallState[] {
  const role = roleForMode(context.mode);
  const refused: ToolCallState[] = [];
  for (const call of generatedToolCalls) {
    const name = call.toolCall.function.name;
    const known = context.tools.find((t) => t.function.name === name);
    const message = roleRefusal(role, known ? ideToolRef(known) : { name }, {
      trust: {
        tools: context.planMcpTools,
        trustedServers: context.trustedMcpServers,
      },
      unattendedMcpTools: context.backgroundMcpTools,
      approvalWaived: context.approvalWaived,
    });
    if (!message) continue;
    refused.push(call);
    dispatch(errorToolCall({ toolCallId: call.toolCallId }));
    dispatch(
      updateToolCallOutput({
        toolCallId: call.toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Tool not available",
            description: `${name} is not available in this mode`,
            content: message,
            hidden: false,
          },
        ],
      }),
    );
  }
  return refused;
}
