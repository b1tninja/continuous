import { getAuditTrail } from "core/tools/permissions/audit/global.js";
import type {
  SettingChangeSource,
  SettingInput,
} from "core/tools/permissions/audit/record.js";
import type { PolicyLevels } from "core/tools/permissions/policy.js";
import {
  diffPolicySettings,
  recordFileEdits,
  recordSettingChanges,
  rememberSettings,
  trustChange,
} from "core/tools/permissions/settingChanges.js";
import { readPolicyFile } from "core/tools/permissions/settingsFile.js";

import { cliAuditSession } from "../audit/cliAudit.js";
import { logger } from "../util/logger.js";

import { PERMISSIONS_YAML_PATH } from "./permissionsYamlLoader.js";
import { getPolicyExtras, getPolicyLevels } from "./policyLevels.js";

/**
 * The CLI's side of the settings audit (CO6): level and preset changes from
 * `/policy` and `--policy`, trust grants from `project trust`, `hooks trust`
 * and the `--trust-project-*` flags, and edits made to permissions.yaml while
 * the CLI was not running. Nothing here throws: the audit never blocks the
 * change it reports.
 */
export function auditLevelChange(
  before: PolicyLevels,
  after: PolicyLevels,
  source: SettingChangeSource,
  confirmed?: SettingInput["confirmed"],
): void {
  try {
    const extras = getPolicyExtras();
    const changes = diffPolicySettings(
      { ...extras, levels: before },
      { ...extras, levels: after },
    );
    recordSettingChanges(
      getAuditTrail((m) => logger.warn(m)),
      changes,
      {
        source,
        confirmed,
        session: cliAuditSession(),
      },
    );
  } catch {
    // the audit never blocks a change
  }
}

/** Edits of permissions.yaml since the CLI last looked; call right after it is loaded. */
export function auditFileEditsAtLoad(): void {
  try {
    recordFileEdits(
      getAuditTrail((m) => logger.warn(m)),
      {
        ...getPolicyExtras(),
        levels: getPolicyLevels(),
      },
    );
  } catch {
    // the audit never blocks start-up
  }
}

/** After the CLI saved the file itself, so the next load does not call it an edit. */
export function rememberSavedPolicyFile(
  file: string = PERMISSIONS_YAML_PATH,
): void {
  try {
    rememberSettings(
      getAuditTrail((m) => logger.warn(m)),
      readPolicyFile(file).settings,
    );
  } catch {
    // a nicety
  }
}

/** A grant or withdrawal of trust. `where` is the project directory. */
export function auditTrust(
  kind: "project-trust" | "hook-trust",
  op: "grant" | "revoke",
  where: string,
  how: {
    source: SettingChangeSource;
    confirmed?: SettingInput["confirmed"];
    scopes?: readonly string[];
  },
): void {
  try {
    const scopes = how.scopes ?? [];
    const name = scopes.length ? `${where} (${scopes.join(", ")})` : where;
    recordSettingChanges(
      getAuditTrail((m) => logger.warn(m)),
      [trustChange(kind, op, name)],
      {
        source: how.source,
        confirmed: how.confirmed,
        session: cliAuditSession(),
      },
    );
  } catch {
    // the audit never blocks a change
  }
}
