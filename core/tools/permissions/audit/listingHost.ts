import fs from "node:fs";
import { getConfigYamlPath } from "../../../util/paths";
import {
  auditDir,
  auditEnabledFromEnv,
  auditEnabledFromYaml,
  auditSettings,
} from "./global";
import type { AuditListHost, AuditStatus } from "./listingHandlers";

/** Whether the trail is on, and which setting says so (the environment wins). */
export function currentAuditStatus(): AuditStatus {
  let text = "";
  try {
    text = fs.readFileSync(getConfigYamlPath(), "utf8");
  } catch {
    // no config.yaml: the default stands
  }
  const s = auditSettings(process.env, text);
  const via =
    auditEnabledFromEnv() !== undefined
      ? "env"
      : auditEnabledFromYaml(text) !== undefined
        ? "config"
        : "default";
  return { enabled: s.enabled, retentionDays: s.retentionDays, via };
}

/** The audit directory and status of this machine, for core's messenger. */
export const machineAuditHost: AuditListHost = {
  dir: auditDir,
  status: currentAuditStatus,
};
