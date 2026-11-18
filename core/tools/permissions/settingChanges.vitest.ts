import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPolicyDecision } from "./audit/hook";
import { callRows, listChanges, readAuditSession } from "./audit/reader";
import { settingDraft, POLICY_SESSION } from "./audit/record";
import { AuditTrail } from "./audit/trail";
import { readAuditFile } from "./audit/writer";
import { DEFAULT_POLICY_LEVELS, type PolicyLevels } from "./policy";
import {
  diffPolicySettings,
  raiseConfirmation,
  raisedLevels,
  recordFileEdits,
  recordSettingChanges,
  rememberSettings,
  trustChange,
} from "./settingChanges";
import type { PolicyFileSettings } from "./settingsFile";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "setting-audit-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = "2026-11-10T12:00:00.000Z";
const trail = (enabled = true) =>
  new AuditTrail({
    dir,
    enabled,
    now: () => new Date(T0),
    syncImportant: false,
  });

const lv = (over: Partial<PolicyLevels> = {}): PolicyLevels => ({
  ...DEFAULT_POLICY_LEVELS,
  ...over,
});
const settings = (
  over: Partial<PolicyFileSettings> = {},
): PolicyFileSettings => ({ levels: lv(), ...over });

describe("raise confirmation (pure)", () => {
  it("lists only moves up to Automatic, Permissive or IDGAF", () => {
    expect(
      raisedLevels(lv(), lv({ tools: "permissive", edits: "idgaf" })),
    ).toEqual([
      { area: "tools", from: "cautious", to: "permissive" },
      { area: "edits", from: "manual", to: "idgaf" },
    ]);
    // Manual to Cautious is a raise, but not toward the levels that ask
    expect(
      raisedLevels(lv({ edits: "manual" }), lv({ edits: "cautious" })),
    ).toEqual([]);
  });

  it("lowering never asks, and an unchanged level never asks", () => {
    expect(
      raiseConfirmation(lv({ tools: "idgaf" }), lv({ tools: "cautious" })),
    ).toBeUndefined();
    expect(raiseConfirmation(lv(), lv())).toBeUndefined();
    expect(
      raiseConfirmation(
        lv({ tools: "permissive" }),
        lv({ tools: "permissive" }),
      ),
    ).toBeUndefined();
  });

  it("names every area and both levels in one line", () => {
    const q = raiseConfirmation(
      lv(),
      lv({ tools: "automatic", edits: "permissive" }),
    );
    expect(q).toContain("tools cautious to automatic");
    expect(q).toContain("edits manual to permissive");
    expect(q).not.toContain("\n");
    expect(q).not.toContain("this session only");
  });

  it("says idgaf is for one session", () => {
    expect(raiseConfirmation(lv(), lv({ plan: "idgaf" }))).toContain(
      "idgaf lasts this session only",
    );
  });
});

describe("diffPolicySettings", () => {
  it("reports each level and the preset the levels add up to", () => {
    const changes = diffPolicySettings(
      settings(),
      settings({ levels: lv({ edits: "permissive" }) }),
    );
    expect(changes).toEqual([
      {
        kind: "level",
        op: "set",
        name: "edits",
        from: "manual",
        to: "permissive",
        loosens: true,
      },
      {
        kind: "preset",
        op: "set",
        name: "preset",
        from: "careful",
        to: "acceptEdits",
        loosens: true,
      },
    ]);
  });

  it("a lowering does not loosen; a mixed result is a custom preset", () => {
    const changes = diffPolicySettings(
      settings({
        levels: {
          context: "permissive",
          tools: "permissive",
          edits: "permissive",
          plan: "permissive",
          questions: "permissive",
        },
      }),
      settings({ levels: lv({ tools: "cautious", plan: "manual" }) }),
    );
    expect(changes.find((c) => c.name === "tools")?.loosens).toBe(false);
    expect(changes.find((c) => c.kind === "preset")?.to).toBe("custom");
  });

  it("reports built-in switch-offs, floor edits, trusted servers and Plan terminal", () => {
    const before = settings({ floor: ["runTerminalCommand(rm -rf *)"] });
    const after = settings({
      builtin: { "no-force-push": false } as never,
      floor: ["runTerminalCommand(dd *)"],
      mcpServers: { github: "trusted" },
      planAllowTerminal: true,
    });
    const changes = diffPolicySettings(before, after);
    const by = (kind: string) => changes.filter((c) => c.kind === kind);
    expect(by("builtin")).toEqual([
      {
        kind: "builtin",
        op: "set",
        name: "no-force-push",
        from: "on",
        to: "off",
        loosens: true,
      },
    ]);
    expect(by("floor").map((c) => [c.op, c.loosens])).toEqual([
      ["add", false],
      ["remove", true],
    ]);
    expect(by("mcp-trust")[0]).toMatchObject({ op: "grant", name: "github" });
    expect(by("plan-terminal")[0]).toMatchObject({ from: "off", to: "on" });
  });

  it("nothing changed is nothing reported", () => {
    expect(diffPolicySettings(settings(), settings())).toEqual([]);
  });
});

describe("setting entries: writer and reader round trip", () => {
  it("writes each kind and lists it back with source, old and new value", () => {
    const t = trail();
    recordSettingChanges(
      t,
      [
        ...diffPolicySettings(
          settings(),
          settings({ levels: lv({ tools: "idgaf" }) }),
        ),
        trustChange("project-trust", "grant", "/work/app (providers)"),
        trustChange("hook-trust", "revoke", "/work/app"),
      ],
      { source: "cli-policy", confirmed: "prompt", session: "cli-1" },
    );
    const rows = listChanges(dir);
    expect(rows.map((r) => r.kind)).toEqual([
      "level",
      "preset",
      "project-trust",
      "hook-trust",
    ]);
    expect(rows[0]).toMatchObject({
      source: "cli-policy",
      loosens: true,
      summary: "set tools: cautious -> idgaf (confirmed: prompt)",
    });
    const file = readAuditSession(dir, POLICY_SESSION);
    expect(file[0]).toMatchObject({
      v: 1,
      ev: "setting",
      kind: "level",
      name: "tools",
      from: "cautious",
      to: "idgaf",
      viaSession: "cli-1",
      seq: 1,
    });
    expect(rows[3].loosens).toBe(false);
  });

  it("masks secrets in a floor rule and never stores more than the name and values", () => {
    const t = trail();
    recordSettingChanges(
      t,
      diffPolicySettings(
        settings(),
        settings({
          floor: [
            "runTerminalCommand(curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')",
          ],
        }),
      ),
      { source: "file" },
    );
    const text = fs.readFileSync(
      fs
        .readdirSync(dir)
        .map((m) => path.join(dir, m, `${POLICY_SESSION}.jsonl`))[0],
      "utf8",
    );
    expect(text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain('"kind":"floor"');
  });

  it("a disabled trail writes nothing and reports success", () => {
    const t = trail(false);
    expect(
      recordSettingChanges(t, [trustChange("hook-trust", "grant", "x")], {
        source: "flag",
      }),
    ).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an old file still reads: decisions and rule policy events are untouched by a setting line", () => {
    const t = trail();
    recordPolicyDecision(
      t,
      {
        session: "s1",
        callId: "c1",
        toolName: "run_terminal_command",
        parsedArgs: { command: "npm test" },
      },
      "allowedWithPermission",
      { policy: "allowedWithoutPermission" },
    );
    t.policy({
      source: "cli",
      op: "add",
      decision: "ask",
      rule: "runTerminalCommand(git push*)",
      loosens: false,
    });
    t.setting({
      kind: "builtin",
      op: "set",
      source: "file",
      name: "x",
      from: "on",
      to: "off",
      loosens: true,
    });
    // an old reader's view: call rows are built from decisions and outcomes only
    expect(callRows(readAuditSession(dir, "s1"))).toHaveLength(1);
    const kinds = listChanges(dir).map((r) => r.kind);
    expect(kinds).toEqual(["rule", "builtin"]);
  });

  it("a kind this reader does not know is listed as written; an unknown ev is skipped", () => {
    const t = trail();
    t.setting({
      kind: "level",
      op: "set",
      source: "file",
      name: "a",
      loosens: false,
    });
    const file = path.join(dir, "2026-11", `${POLICY_SESSION}.jsonl`);
    fs.appendFileSync(
      file,
      `${JSON.stringify({ v: 1, ev: "setting", ts: T0, session: POLICY_SESSION, seq: 9, kind: "future-kind", op: "set", source: "somewhere", name: "n", loosens: false })}\n` +
        `${JSON.stringify({ v: 1, ev: "from-the-future", ts: T0, session: POLICY_SESSION, seq: 10 })}\n`,
    );
    const rows = listChanges(dir);
    expect(rows.map((r) => r.kind)).toEqual(["level", "future-kind"]);
    expect(readAuditFile(file)).toHaveLength(3);
  });

  it("settingDraft keeps the envelope in the policy-changes session", () => {
    const d = settingDraft({
      kind: "level",
      op: "set",
      source: "flag",
      name: "tools",
      from: "a",
      to: "b",
      loosens: true,
    });
    expect(d).toMatchObject({ ev: "setting", session: POLICY_SESSION });
  });
});

describe("edits to the file, seen at load", () => {
  it("the first load only records a baseline", () => {
    const t = trail();
    expect(recordFileEdits(t, settings())).toEqual([]);
    expect(listChanges(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "settings-seen.json"))).toBe(true);
  });

  it("a later load reports what the file now says, once", () => {
    const t = trail();
    recordFileEdits(t, settings());
    const edited = settings({
      levels: lv({ tools: "permissive" }),
      builtin: { "no-force-push": false } as never,
    });
    const found = recordFileEdits(t, edited);
    expect(found.map((c) => c.kind)).toEqual(["level", "preset", "builtin"]);
    expect(listChanges(dir).every((r) => r.source === "file")).toBe(true);
    expect(recordFileEdits(t, edited)).toEqual([]);
  });

  it("a change this process saved is not reported as an edit", () => {
    const t = trail();
    recordFileEdits(t, settings());
    rememberSettings(t, settings({ levels: lv({ edits: "permissive" }) }));
    expect(
      recordFileEdits(t, settings({ levels: lv({ edits: "permissive" }) })),
    ).toEqual([]);
  });

  it("an unreadable snapshot is a first run, not a failure", () => {
    const t = trail();
    fs.writeFileSync(path.join(dir, "settings-seen.json"), "{nope");
    expect(recordFileEdits(t, settings())).toEqual([]);
  });
});
