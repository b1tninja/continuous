/**
 * Settings a Test connection result suggests for a model, compared with what
 * the model has now: only a suggestion that would change something is made.
 * Pure: the tester shows the list and the Configure dialog applies it to its
 * form, where the person still reviews the YAML diff and saves.
 */
import type { ListedLimits } from "./listedModelLimits.js";

export type ToolsChoice = "auto" | "on" | "off";

export interface TestFindings {
  listedLimits?: Pick<ListedLimits, "contextLength" | "kind">;
  probe?: {
    kind: "native" | "text" | "none" | "unknown";
    /** `toolDialect` that recovers calls written as text; unset when the server parses them. */
    recoveryDialect?: string;
  };
}

export interface CurrentSettings {
  contextLength?: number;
  /** The `toolDialect` set, "" or undefined for auto-detect. */
  toolDialect?: string;
  tools: ToolsChoice;
}

export type Suggestion =
  | { key: "contextLength"; value: number; label: string; reason: string }
  | { key: "toolDialect"; value: string; label: string; reason: string }
  | { key: "tools"; value: ToolsChoice; label: string; reason: string };

export function suggestSettings(
  found: TestFindings,
  current: CurrentSettings,
): Suggestion[] {
  const out: Suggestion[] = [];

  const window = found.listedLimits?.contextLength;
  const kind = found.listedLimits?.kind;
  if (window !== undefined && window !== current.contextLength) {
    if (kind === "loaded" || kind === "max") {
      out.push({
        key: "contextLength",
        value: window,
        label: `Context length: ${window.toLocaleString()} tokens`,
        reason:
          kind === "loaded"
            ? "The server runs this model with that window."
            : "The server lists that window for this model.",
      });
    } else if (
      kind === "trained" &&
      current.contextLength !== undefined &&
      current.contextLength > window
    ) {
      // The trained window is a ceiling: only lower a setting that passes it
      out.push({
        key: "contextLength",
        value: window,
        label: `Context length: ${window.toLocaleString()} tokens`,
        reason: "The model was trained for no more than that.",
      });
    }
  }

  const probe = found.probe;
  if (probe?.kind === "text" && probe.recoveryDialect) {
    if ((current.toolDialect ?? "") !== probe.recoveryDialect) {
      out.push({
        key: "toolDialect",
        value: probe.recoveryDialect,
        label: `Tool dialect: ${probe.recoveryDialect}`,
        reason: "The model wrote its tool calls as text in that form.",
      });
    }
  }
  if (probe?.kind === "none" && current.tools !== "off") {
    out.push({
      key: "tools",
      value: "off",
      label: "Tools: described in the system message",
      reason: "The model did not accept native tool calls.",
    });
  }
  if (probe?.kind === "native" && current.tools === "off") {
    out.push({
      key: "tools",
      value: "auto",
      label: "Tools: auto-detect",
      reason: "The model accepted native tool calls.",
    });
  }
  return out;
}
