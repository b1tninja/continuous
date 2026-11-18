import type { AreaReport } from "core/tools/permissions/effectiveRules.js";

/**
 * The built-in rules of one area for `continuous permissions list`: each rule's
 * id, its switch, what it asks about, and the exact-command Always rules that
 * exempt a command from it (ROADMAP B55, B60).
 */
export function printBuiltins(
  builtins: AreaReport["builtins"],
  out: (line: string) => void,
): void {
  if (builtins.length === 0) return;
  out("  Built-in rules (switch: builtin.<id> in permissions.yaml)");
  for (const b of builtins) {
    out(`    ${b.id} [${b.on ? "on" : "off - loosened"}] ${b.label}`);
    out(`        ${b.description}`);
    for (const rule of b.exemptedBy ?? []) {
      out(`        exempts ${b.id}: ${rule}`);
    }
  }
}
