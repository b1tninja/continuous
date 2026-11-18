import { getAuditTrail } from "../../tools/permissions/audit/global";
import {
  policyLevelLabel,
  questionsNeverAsk,
  type PolicyLevel,
} from "../../tools/permissions/policy";
import { declineElicitation, type InputRequestHandler } from "./mcpMrtr";

/**
 * What the client says to a server that asks the person something
 * (`elicitation/create`, revision 2026-07-28). No form is ever put in front of
 * the person, at any level: the request is declined. Where Questions is IDGAF the server's own defaults answer it when it has them for every
 * field, because the person said nobody is asked and nothing waits; a form
 * that has no default for a field, asks for a secret, or sends the person to a
 * page (url mode) is declined, never filled in with an invented value.
 */

/** A field that asks for something only the person holds. */
const SECRET_FIELD =
  /pass(word|phrase|code)?\b|secret|token|api[-_ ]?key|credential|private[-_ ]?key|\bpin\b|\botp\b|2fa|mfa/i;

export interface ElicitationOutcome {
  response: { action: "accept" | "decline"; content?: Record<string, unknown> };
  /** What was done and why, one sentence, for the audit trail */
  note: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pure: how an `elicitation/create` request is answered when nobody is asked. */
export function answerElicitationWithoutAsking(
  params: Record<string, unknown> | undefined,
): ElicitationOutcome {
  const declined = (why: string): ElicitationOutcome => ({
    response: { action: "decline" },
    note: `Declined: ${why}`,
  });
  if (params?.mode === "url") {
    return declined(
      "the server sends the person to a page, which nobody is here to open",
    );
  }
  const schema = params?.requestedSchema;
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    return declined("the form has no fields with a default to answer from");
  }
  const required = new Set(
    isRecord(schema) && Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  const content: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(properties)) {
    const field = isRecord(raw) ? raw : {};
    const text = [name, field.title, field.description]
      .filter((t) => typeof t === "string")
      .join(" ");
    if (field.format === "password" || SECRET_FIELD.test(text)) {
      return declined(
        `field "${name}" asks for a secret, which is never invented`,
      );
    }
    if (field.default === undefined) {
      if (required.has(name)) {
        return declined(
          `required field "${name}" has no default, and none is invented`,
        );
      }
      continue;
    }
    content[name] = field.default;
  }
  if (Object.keys(content).length === 0) {
    return declined("the form has no fields with a default to answer from");
  }
  return {
    response: { action: "accept", content },
    note: `Accepted with the server's own defaults for ${Object.keys(content).join(", ")}`,
  };
}

/**
 * The handler a modern MCP client uses. `level` is read at the time of the
 * request, so a change of the Questions level applies to the next one.
 */
export function elicitationHandler(
  level: () => PolicyLevel | undefined,
  record: (note: string) => void = recordElicitation,
): InputRequestHandler {
  return async (key, request) => {
    if (
      request.method !== "elicitation/create" ||
      !questionsNeverAsk(level())
    ) {
      return declineElicitation(key, request);
    }
    const outcome = answerElicitationWithoutAsking(request.params);
    record(
      `${outcome.note} (${String(request.params?.message ?? "").slice(0, 120)})`,
    );
    return outcome.response;
  };
}

function recordElicitation(note: string): void {
  try {
    getAuditTrail().decision({
      callId: `mcp-elicitation-${Date.now()}`,
      tool: "mcp:elicitation",
      args: "{}",
      policy: note.startsWith("Accepted") ? "allow" : "deny",
      by: "system",
      source: `Questions: ${policyLevelLabel("questions", "idgaf")}`,
      reason: note,
    });
  } catch {
    // the audit never blocks a call
  }
}

let currentLevel: PolicyLevel | undefined;

/** The Questions level of the latest policy check core was given. */
export function setQuestionsLevel(level: PolicyLevel | undefined): void {
  currentLevel = level;
}

export function currentQuestionsLevel(): PolicyLevel | undefined {
  return currentLevel;
}
