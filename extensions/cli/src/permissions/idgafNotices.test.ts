import fs from "node:fs";
import path from "node:path";

import type { Session } from "core/index.js";
import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => ({ settings: [] as Record<string, unknown>[] }));
vi.mock("core/tools/permissions/audit/global.js", () => ({
  getAuditTrail: () => ({
    enabled: true,
    setting: (s: Record<string, unknown>) => {
      audit.settings.push(s);
      return true;
    },
  }),
}));

import { env } from "../env.js";
import { loadSession, loadSessionById } from "../session.js";
import { resetUserNotices, setUserNoticeSink } from "../util/userNotice.js";

import {
  announceIdgaf,
  auditEnvLoosening,
  noteResumedSession,
  rememberIdgafFlag,
  resetIdgafNotices,
  RESUMED_WITHOUT_IDGAF_NOTICE,
} from "./idgafNotices.js";

const IDGAF = POLICY_PRESETS.idgaf.levels;

let notices: string[];

beforeEach(() => {
  notices = [];
  audit.settings = [];
  resetUserNotices();
  resetIdgafNotices();
  setUserNoticeSink((text) => notices.push(text));
});

afterEach(() => {
  resetUserNotices();
  resetIdgafNotices();
});

const session = (over: Partial<Session> = {}): Session => ({
  sessionId: "s-1",
  title: "t",
  workspaceDirectory: "/w",
  history: [],
  ...over,
});

describe("the IDGAF start line (D-001, D-002)", () => {
  it("is said once per session, never asked, and names what stops nothing", () => {
    const s = session();
    announceIdgaf(IDGAF, s);
    announceIdgaf(IDGAF, s);
    announceIdgaf(IDGAF, s);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      "IDGAF is on for this session only: your rules, locked rules and protected files stop nothing; each call runs and the audit trail records what would have stopped it. Tools you switched off stay off.",
    );
  });

  it("says nothing below IDGAF", () => {
    announceIdgaf({ ...DEFAULT_POLICY_LEVELS }, session());
    expect(notices).toEqual([]);
    expect(audit.settings).toEqual([]);
  });

  it("names the areas and the flag that turned it on (B21: session only)", () => {
    rememberIdgafFlag("--auto");
    announceIdgaf(
      {
        ...DEFAULT_POLICY_LEVELS,
        context: "idgaf",
        tools: "idgaf",
        edits: "idgaf",
      },
      session(),
    );
    expect(notices[0]).toMatch(
      /^IDGAF is on for Context use, Tool use, File edits for this session only \(--auto\): /,
    );
  });

  it("at Questions IDGAF alone says that nobody is asked, not that rules are ignored", () => {
    announceIdgaf({ ...DEFAULT_POLICY_LEVELS, questions: "idgaf" }, session());
    expect(notices[0]).toContain("the agent answers its own questions");
    expect(notices[0]).not.toContain("locked rules");
  });

  it("marks the session so a later --resume can say IDGAF was not restored", () => {
    const s = session();
    announceIdgaf({ ...DEFAULT_POLICY_LEVELS, tools: "idgaf" }, s);
    expect(s.idgafAreas).toEqual(["tools"]);
  });

  it("writes one idgaf-session audit record", () => {
    rememberIdgafFlag("--policy idgaf");
    announceIdgaf(IDGAF, session());
    announceIdgaf(IDGAF, session());
    expect(audit.settings).toEqual([
      expect.objectContaining({
        kind: "idgaf-session",
        op: "set",
        source: "flag",
        confirmed: "flag",
        to: "idgaf",
        loosens: true,
        session: "s-1",
      }),
    ]);
  });
});

describe("B21: a loosening from the environment is audited apart", () => {
  it("writes an env-loosening record, not an idgaf-session one", () => {
    auditEnvLoosening("CONTINUOUS_HEADLESS_LEGACY_ALLOW", "1");
    expect(audit.settings).toEqual([
      expect.objectContaining({
        kind: "env-loosening",
        source: "env",
        name: "CONTINUOUS_HEADLESS_LEGACY_ALLOW",
        to: "1",
        loosens: true,
      }),
    ]);
  });
});

describe("--resume of a session that ran at IDGAF (ID 5)", () => {
  it("drops the saved areas and says so in one line", () => {
    const s = session({ idgafAreas: ["tools", "edits"] });
    noteResumedSession(s);
    noteResumedSession(session({ idgafAreas: ["tools"] }));
    expect(s.idgafAreas).toBeUndefined();
    expect(notices).toEqual([RESUMED_WITHOUT_IDGAF_NOTICE]);
  });

  it("says nothing for a session that never ran at IDGAF", () => {
    noteResumedSession(session());
    expect(notices).toEqual([]);
  });

  it("says nothing when a flag of this run turned IDGAF on again", () => {
    rememberIdgafFlag("--policy idgaf");
    const s = session({ idgafAreas: ["tools"] });
    noteResumedSession(s);
    expect(notices).toEqual([]);
    expect(s.idgafAreas).toBeUndefined();
  });

  describe("through session.ts", () => {
    const dir = path.join(env.continueHome, "sessions");
    const savedTestFlag = process.env.CONTINUE_CLI_TEST;

    beforeEach(() => {
      delete process.env.CONTINUE_CLI_TEST;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const saved: Session = {
        sessionId: "ran-at-idgaf",
        title: "Unattended",
        workspaceDirectory: "/work/project",
        history: [
          { message: { role: "user", content: "hi" }, contextItems: [] },
        ],
        idgafAreas: ["context", "tools", "edits", "plan", "questions"],
      };
      fs.writeFileSync(
        path.join(dir, "ran-at-idgaf.json"),
        JSON.stringify(saved),
      );
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (savedTestFlag !== undefined) {
        process.env.CONTINUE_CLI_TEST = savedTestFlag;
      }
    });

    it("--resume starts at the configured levels and prints the line once", () => {
      const resumed = loadSession({ cwd: "/work/project" });
      expect(resumed?.sessionId).toBe("ran-at-idgaf");
      expect(resumed?.idgafAreas).toBeUndefined();
      // The TUI may load it again while it starts: still one line
      loadSession({ cwd: "/work/project" });
      expect(notices).toEqual([RESUMED_WITHOUT_IDGAF_NOTICE]);
    });

    it("a session loaded by id for another purpose says nothing", () => {
      expect(loadSessionById("ran-at-idgaf")?.idgafAreas).toHaveLength(5);
      expect(notices).toEqual([]);
    });
  });
});
