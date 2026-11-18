import fs from "fs";
import os from "os";
import path from "path";

import { setAuditTrailForTests } from "core/tools/permissions/audit/global.js";
import { listChanges } from "core/tools/permissions/audit/reader.js";
import { AuditTrail } from "core/tools/permissions/audit/trail.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { processCommandFlags } from "../flags/flagProcessor.js";
import { handleSlashCommands } from "../slashCommands.js";

import { setAutoReviewEnabled } from "./coreRules.js";
import { auditTrust } from "./policyAudit.js";
import { getPolicyLevels, resetPolicyLevels } from "./policyLevels.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-policy-audit-"));
  setAuditTrailForTests(
    new AuditTrail({
      dir: path.join(dir, "audit"),
      enabled: true,
      syncImportant: false,
    }),
  );
});

afterEach(() => {
  setAuditTrailForTests(undefined);
  resetPolicyLevels();
  setAutoReviewEnabled(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

const changes = () => listChanges(path.join(dir, "audit"));

describe("/policy raises ask once, and every change is audited", () => {
  it("a raise to Permissive does not apply until it is confirmed, and names what changes", async () => {
    const r = await handleSlashCommands(
      "/policy tools=permissive",
      {} as never,
    );
    expect(r?.output).toContain("tools cautious to permissive");
    expect(r?.output).toContain("Nothing was changed");
    expect(r?.output).toContain("/policy tools=permissive --yes");
    expect(getPolicyLevels().tools).toBe("cautious");
    expect(changes()).toEqual([]);
  });

  it("with --yes it applies, and the audit line says who, what, from, to and how", async () => {
    await handleSlashCommands("/policy tools=permissive --yes", {} as never);
    expect(getPolicyLevels().tools).toBe("permissive");
    const rows = changes();
    expect(rows.map((r) => r.kind)).toEqual(["level", "preset"]);
    expect(rows[0]).toMatchObject({
      ev: "setting",
      source: "cli-policy",
      loosens: true,
      summary: "set tools: cautious -> permissive (confirmed: prompt)",
    });
    expect(rows[1].summary).toContain("careful -> custom");
  });

  it("IDGAF asks too, and says it lasts one session", async () => {
    const r = await handleSlashCommands("/policy idgaf", {} as never);
    expect(r?.output).toContain("idgaf lasts this session only");
    expect(getPolicyLevels().tools).toBe("cautious");
  });

  it("lowering never asks, and is audited", async () => {
    await handleSlashCommands("/policy handsOff --yes", {} as never);
    const before = changes().length;
    const r = await handleSlashCommands("/policy careful", {} as never);
    expect(r?.output).not.toContain("Nothing was changed");
    expect(getPolicyLevels().tools).toBe("cautious");
    const added = changes().slice(before);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((c) => !c.loosens)).toBe(true);
    expect(added.every((c) => !c.summary.includes("confirmed"))).toBe(true);
  });

  it("Manual to Cautious is not a raise toward the levels that ask", async () => {
    await handleSlashCommands("/policy edits=cautious", {} as never);
    expect(getPolicyLevels().edits).toBe("cautious");
  });

  it("a spec that does not parse changes and records nothing", async () => {
    await handleSlashCommands("/policy tools=never --yes", {} as never);
    expect(changes()).toEqual([]);
  });
});

describe("flags are explicit: no prompt, but audited", () => {
  it("--policy applies at once and records source flag", () => {
    processCommandFlags({ policy: "handsOff" });
    expect(getPolicyLevels().tools).toBe("permissive");
    const rows = changes();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (r) => r.source === "flag" && r.summary.endsWith("(confirmed: flag)"),
      ),
    ).toBe(true);
  });

  it("--auto records the tool areas going to IDGAF", () => {
    processCommandFlags({ auto: true });
    const rows = changes();
    expect(rows.map((r) => r.summary)).toContain(
      "set tools: cautious -> idgaf (confirmed: flag)",
    );
  });
});

describe("trust grants", () => {
  it("records who trusted what, from which surface", () => {
    auditTrust("project-trust", "grant", "/work/app", {
      source: "cli-command",
      confirmed: "prompt",
      scopes: ["providers", "models"],
    });
    auditTrust("hook-trust", "grant", "/work/app", {
      source: "flag",
      confirmed: "flag",
    });
    auditTrust("hook-trust", "revoke", "/work/app", { source: "cli-command" });
    const rows = changes();
    expect(rows.map((r) => [r.kind, r.source, r.loosens])).toEqual([
      ["project-trust", "cli-command", true],
      ["hook-trust", "flag", true],
      ["hook-trust", "cli-command", false],
    ]);
    expect(rows[0].summary).toBe(
      "grant /work/app (providers, models): - -> trusted (confirmed: prompt)",
    );
  });
});
