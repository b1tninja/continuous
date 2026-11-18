import { maskCommandForDisplay } from "../../tools/permissions/displayMask";
import { isSecretName } from "../../util/secretScan";

import type { McpNamedValue, McpValueReference } from "./types";

/*
  How a pasted value is classified: a reference to another tool's variable,
  a placeholder the README asks the reader to replace, a credential, or an
  ordinary value. Pure; never logs a value.
*/

/** The importer's rule (core/config/importClineMcp.ts), so both agree. */
const SECRET_KEY =
  /key|token|secret|passw|credential|auth(?!or)|bearer|cookie|session|pat$/i;
const SECRET_VALUE =
  /^(?:Bearer\s+|Basic\s+)?(ghp_|gho_|ghs_|github_pat_|sk-|sk_|xox[abprs]-|AKIA|AIza|glpat-|ntn_|secret_|npm_)/;

const PLACEHOLDER =
  /^<[^>]*>$|^\{[^}]*\}$|^\[[^\]]*\]$|^(?:your|my|insert|enter|replace|put)[-_ ]|[-_ ](?:here|goes[-_ ]here)$|^x{3,}$|\*{3,}|\.\.\.|…|^(?:token|key|secret|password|changeme|example|placeholder|todo|xxx+)$/i;

/** `YOUR_TOKEN`, `<api key>`, `ntn_****`, `sk-...`, `xoxb-your-bot-token`. */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (PLACEHOLDER.test(v)) return true;
  // `YOUR_SENTRY_TOKEN`, `xoxb-your-bot-token`, `Bearer your-token`
  return (
    /(?:^|[-_ :])your[-_ ]?[a-z]/i.test(v) && !/[0-9].*[0-9].*[0-9]/.test(v)
  );
}

const REF_PATTERNS: [McpValueReference["kind"], RegExp][] = [
  ["secret", /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/],
  ["vscode-input", /\$\{input:([^}]+)\}/],
  ["env", /\$\{env:([^}]+)\}/],
  ["env", /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/],
];

/** The first `${...}` reference in a value. */
export function referenceIn(value: string): McpValueReference | undefined {
  for (const [kind, re] of REF_PATTERNS) {
    const m = re.exec(value);
    if (m) return { kind, name: m[1].trim() };
  }
  return undefined;
}

/** Variables our config does not expand, such as `${workspaceFolder}`. */
export function foreignVariablesIn(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/\$\{(?!\{)([^}]+)\}/g)) out.push(m[1]);
  return out;
}

/** Whether a literal value has the shape of a credential. */
export function looksLikeSecretValue(name: string, value: string): boolean {
  const v = value.trim();
  if (!v || isPlaceholderValue(v) || referenceIn(v)) return false;
  if (/^(?:true|false|yes|no|on|off|\d+(?:\.\d+)?)$/i.test(v)) return false;
  if (SECRET_VALUE.test(v)) return true;
  if (maskCommandForDisplay(v) !== v) return true;
  if (maskCommandForDisplay(`${name}=${v}`) !== `${name}=${v}`) return true;
  // By name alone only a value that could be generated: not an address, a
  // URL, a path or a short word such as `aws` or `oauth`
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v) || /:\/\//.test(v)) return false;
  if (v.length < 8 || /^[a-z]+(?:[- ][a-z]+)*$/i.test(v)) return false;
  return SECRET_KEY.test(name) || isSecretName(name);
}

/** Classify one pasted environment variable or header. */
export function namedValue(
  name: string,
  raw: unknown,
  secretInputs: ReadonlySet<string> = new Set(),
): McpNamedValue {
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : undefined;
  if (value === undefined) {
    return { name, secretLooking: false, placeholder: false };
  }
  const reference = referenceIn(value);
  if (reference) {
    // A reference is kept as a name only; the value lives in the other tool
    const secret =
      reference.kind === "secret" ||
      (reference.kind === "vscode-input" && secretInputs.has(reference.name)) ||
      SECRET_KEY.test(name) ||
      SECRET_KEY.test(reference.name);
    return { name, reference, secretLooking: secret, placeholder: false };
  }
  const placeholder = isPlaceholderValue(value);
  return {
    name,
    value,
    secretLooking: !placeholder && looksLikeSecretValue(name, value),
    placeholder,
  };
}

/** Whether a header carries a credential by its name alone. */
export function isCredentialHeader(name: string): boolean {
  return (
    /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i.test(
      name,
    ) || SECRET_KEY.test(name)
  );
}
