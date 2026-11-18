import { ToolCallState } from "core";
import type { AuditAgent } from "core/tools/permissions/audit/record";
import { withheldToolRefusal } from "core/tools/toolListHold";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { errorToolCall, updateToolCallOutput } from "../slices/sessionSlice";
import { AppThunkDispatch } from "../store";

/**
 * Withheld, not removed (C88): a tool turned off while the prompt cache was
 * warm stays in the request's tool list until the cache goes cold, so the
 * model can still call it. Such a call is refused here, before any rule or
 * prompt, with a result that says why, and core writes the refusal to the
 * audit trail like any other.
 */
export async function refuseWithheldCalls(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  calls: ToolCallState[],
  withheld: { name: string; gone: boolean }[],
  audit: { sessionId?: string; agent?: AuditAgent },
): Promise<ToolCallState[]> {
  if (withheld.length === 0) return [];
  const refused: ToolCallState[] = [];
  for (const call of calls) {
    const name = call.toolCall.function.name;
    const hit = withheld.find((w) => w.name === name);
    if (!hit) continue;
    const content = withheldToolRefusal(name, hit.gone);
    refused.push(call);
    try {
      await ideMessenger.request("tools/evaluatePolicy", {
        toolName: name,
        basePolicy: "disabled",
        parsedArgs: call.parsedArgs ?? {},
        callId: call.toolCallId,
        ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
        ...(audit.agent ? { agent: audit.agent } : {}),
        withheld: content.split("\n\n")[0],
      });
    } catch {
      // the audit never blocks a refusal
    }
    dispatch(errorToolCall({ toolCallId: call.toolCallId }));
    dispatch(
      updateToolCallOutput({
        toolCallId: call.toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Tool turned off",
            description: `${name} is withheld until the prompt cache goes cold`,
            content,
            hidden: false,
          },
        ],
      }),
    );
  }
  return refused;
}
