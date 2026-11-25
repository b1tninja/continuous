/**
 * Which safety check owns each kind of block. One table, read by the
 * permission evaluator (is this protection's check on?), the guards a tool
 * runs by itself, and the shield in the UI (which switch turns a blocked call
 * off). Every protection belongs to exactly one check.
 */
import { builtinIsOn, type BuiltinRuleId } from "./policy";
import type { ProtectedKind } from "./protected";

export const CHECK_OF_PROTECTION: Record<ProtectedKind, BuiltinRuleId> = {
  secret: "protect-secrets",
  "private-url": "protect-secrets",
  config: "protect-config",
  network: "protect-network-paths",
  "fetch-and-run": "no-fetch-and-run",
  "destructive-command": "ask-destructive-commands",
  "large-change": "ask-large-change",
  "dependency-change": "ask-dependency-change",
  "unknown-host": "ask-unknown-host",
  "file-deputy": "ask-outside-paths",
  "hidden-command": "refuse-dangerous-commands",
  "env-assignment": "refuse-dangerous-commands",
  "mcp-definition-changed": "approve-mcp-tools",
};

/** The check behind a protection kind, when the kind is one this table knows. */
export function checkOfProtection(
  kind: string | undefined,
): BuiltinRuleId | undefined {
  return kind && kind in CHECK_OF_PROTECTION
    ? CHECK_OF_PROTECTION[kind as ProtectedKind]
    : undefined;
}

/** A check is on unless its switch says false (absent means on). */
function checkOn(
  builtin: Partial<Record<BuiltinRuleId, boolean>> | undefined,
  id: BuiltinRuleId,
): boolean {
  return builtinIsOn(builtin, id);
}

/** The protection kinds whose check is off, so the call skips them. */
export function protectionsWithCheckOff(
  approval: { builtin?: Partial<Record<BuiltinRuleId, boolean>> } | undefined,
): ProtectedKind[] {
  return (Object.keys(CHECK_OF_PROTECTION) as ProtectedKind[]).filter(
    (kind) => !checkOn(approval?.builtin, CHECK_OF_PROTECTION[kind]),
  );
}
