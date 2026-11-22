import type { BrowserSerializedContinueConfig } from "core";
import { draftFromConfig, TABLE_MODES } from "../../util/modeModelsDraft";
import { MODE_LABEL } from "./components/ModeCell";

/**
 * The one line each folded group on the Models tab shows while closed, from
 * the same state the group's controls read. "Not set" names what is used
 * when the person chose nothing.
 */

/** Models per mode: each mode's own model, and how many modes have none. */
export function modeModelsSummary(
  config: Pick<BrowserSerializedContinueConfig, "modeModels">,
): string {
  const draft = draftFromConfig(config);
  const set = TABLE_MODES.filter((m) => draft[m].defaultTitle);
  if (set.length === 0) {
    return "Not set: no mode has a model of its own, so each uses the Chat model selected above";
  }
  const named = set.map((m) => `${MODE_LABEL[m]}: ${draft[m].defaultTitle}`);
  const rest = TABLE_MODES.length - set.length;
  return `${named.join(". ")}.${rest > 0 ? ` ${rest} not set` : ""}`;
}

type RoleConfig = Pick<
  BrowserSerializedContinueConfig,
  "selectedModelByRole" | "experimental"
>;

/** Roles: the model picked for each role the fold holds. */
export function rolesSummary(config: RoleConfig): string {
  const roles: ["apply" | "embed" | "rerank" | "reviewer", string][] = [
    ["apply", "Apply"],
    ["embed", "Embed"],
    ["rerank", "Rerank"],
  ];
  // The reviewer row is shown only while auto approval is switched on
  if (config.experimental?.enableAutoApproval) {
    roles.push(["reviewer", "Reviewer"]);
  }
  return roles
    .map(
      ([role, label]) =>
        `${label}: ${config.selectedModelByRole[role]?.title ?? "not set"}`,
    )
    .join(". ");
}

/** Accounts: the named accounts in providers.yaml. */
export function accountsSummary(names: string[] | undefined): string {
  if (!names) return "Reading providers.yaml…";
  if (names.length === 0) {
    return "Not set: no account in providers.yaml. A connection keeps its own address and key";
  }
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `${names.length} ${names.length === 1 ? "account" : "accounts"} in providers.yaml: ${shown}${more}`;
}

export interface ModelInformationStatus {
  policy: "automatic" | "ask" | "never" | "off";
  refreshHours: number;
  openrouter?: { fetchedAt: string; count: number };
}

/** Model information: how the list is kept current, and when it was last pulled. */
export function modelInformationSummary(
  status: ModelInformationStatus | undefined,
): string {
  if (!status) return "Reading the setting…";
  if (status.policy === "off") {
    return "Off: openrouter.ai is never contacted. The bundled model data is used";
  }
  const how =
    status.policy === "automatic"
      ? `Automatic, every ${status.refreshHours} ${status.refreshHours === 1 ? "hour" : "hours"}`
      : "Only when you ask";
  // The day in UTC, as the file records it
  const day = status.openrouter?.fetchedAt.slice(0, 10);
  return `${how}. ${day ? `Last pulled ${day}` : "Not pulled yet: the bundled model data is used"}`;
}
