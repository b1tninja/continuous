import { describe, expect, it } from "vitest";
import { BuiltInToolNames } from "../builtIn";
import {
  listSessionsTool,
  sendMessageTool,
  toolForPolicy,
} from "../definitions/sessionMessaging";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { areaOfTool, POLICY_PRESETS, type PolicyPresetName } from "./policy";

/**
 * list_sessions and send_message are answered by the gui and never sit in
 * the config's tool list. Core's handler looks the tool up with
 * toolForPolicy, which falls back to them, as here.
 */
function decide(
  toolName: string,
  preset: PolicyPresetName,
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] },
) {
  const tool = toolForPolicy([], toolName)!;
  return evaluateToolPolicyWithRules({
    tool,
    toolName,
    basePolicy: tool.defaultToolPolicy!,
    parsedArgs:
      toolName === BuiltInToolNames.SendMessage
        ? { to: "call_b", message: "found it" }
        : {},
    permissions,
    approval: { levels: POLICY_PRESETS[preset].levels },
  }).policy;
}

describe("the messaging tools in the policy table", () => {
  it("finds the gui's tools when the config's list does not have them", () => {
    expect(toolForPolicy([], BuiltInToolNames.SendMessage)).toBe(
      sendMessageTool,
    );
    expect(toolForPolicy([], BuiltInToolNames.ListSessions)).toBe(
      listSessionsTool,
    );
    expect(toolForPolicy([], "nope")).toBeUndefined();
    const configured = { function: { name: BuiltInToolNames.SendMessage } };
    expect(toolForPolicy([configured], BuiltInToolNames.SendMessage)).toBe(
      configured,
    );
  });

  it("puts list_sessions under Context and send_message under Tools, by name", () => {
    expect(areaOfTool(BuiltInToolNames.ListSessions, undefined)).toBe(
      "context",
    );
    expect(areaOfTool(BuiltInToolNames.SendMessage, undefined)).toBe("tools");
    // Even if a caller passed the tool, a message is never read-only Context
    expect(areaOfTool(BuiltInToolNames.SendMessage, { readonly: true })).toBe(
      "tools",
    );
  });

  it.each<[PolicyPresetName, string]>([
    ["careful", "allowedWithPermission"],
    ["acceptEdits", "allowedWithPermission"],
    ["handsOff", "allowedWithoutPermission"],
    ["idgaf", "allowedWithoutPermission"],
  ])("send_message at %s: %s", (preset, expected) => {
    expect(decide(BuiltInToolNames.SendMessage, preset)).toBe(expected);
  });

  it("lists without asking at Careful", () => {
    expect(decide(BuiltInToolNames.ListSessions, "careful")).toBe(
      "allowedWithoutPermission",
    );
  });

  it("honours the person's rules for send_message below IDGAF", () => {
    expect(
      decide(BuiltInToolNames.SendMessage, "handsOff", {
        deny: ["send_message"],
      }),
    ).toBe("disabled");
    expect(
      decide(BuiltInToolNames.SendMessage, "careful", {
        allow: ["send_message"],
      }),
    ).toBe("allowedWithoutPermission");
  });
});
