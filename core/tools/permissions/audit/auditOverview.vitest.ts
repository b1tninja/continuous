import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleSourcesInput } from "../effectiveRules";
import { updateIndex } from "./auditIndex";
import {
  askAndAnswer,
  decisionEvent,
  jsonl,
  resetSeq,
  sessionFile,
  T0,
} from "./auditIndexFixtures";
import { buildOverview } from "./auditOverview";
import { auditOverview } from "./overviewHandler";

const NOW = new Date(T0 + 3 * 86_400_000);
const BASH = "run_terminal_command";
const cmd = (command: string) => ({ command });
const LEVELS = {
  context: "cautious",
  tools: "cautious",
  edits: "cautious",
  plan: "cautious",
  questions: "cautious",
} as const;
const SOURCES: RuleSourcesInput = { levels: LEVELS as never };
let dir: string;

beforeEach(() => {
  resetSeq();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-overview-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function trail(events: unknown[]) {
  fs.writeFileSync(sessionFile(dir, "2026-11", "s1"), jsonl(events));
}

const host = (sources: RuleSourcesInput = SOURCES) => ({
  sources: async () => sources,
  cwd: async () => "/home/dev/shop",
  dir: () => dir,
  now: () => NOW,
});

describe("the page's audit figures", () => {
  it("says asked and matched per rule, and hints at a rule nothing used", async () => {
    trail([
      decisionEvent("a", BASH, cmd("git push"), {
        rule: "runTerminalCommand(git push*)",
        source: "ask-rule",
      }),
      decisionEvent("b", BASH, cmd("git push"), {
        rule: "runTerminalCommand(git push*)",
        source: "ask-rule",
      }),
      decisionEvent("c", BASH, cmd("git status"), {
        policy: "allow",
        rule: "runTerminalCommand(git status*)",
        source: "allow-rule",
      }),
    ]);
    updateIndex(dir, { now: NOW });
    const o = await auditOverview(
      {
        rules: [
          "runTerminalCommand(git push*)",
          "runTerminalCommand(git status*)",
          "runTerminalCommand(rm -rf build*)",
        ],
      },
      host(),
    );
    expect(o.state).toBe("ready");
    expect(o.rules["runTerminalCommand(git push*)"]).toMatchObject({
      asked: 2,
      matched: 2,
      unused: false,
    });
    expect(o.rules["runTerminalCommand(git status*)"]).toMatchObject({
      asked: 0,
      matched: 1,
    });
    expect(o.rules["runTerminalCommand(rm -rf build*)"]).toMatchObject({
      asked: 0,
      matched: 0,
      unused: true,
    });
  });

  it("claims nothing when the audit has no history", async () => {
    const o = await auditOverview(
      { rules: ["runTerminalCommand(a*)"] },
      host(),
    );
    expect(o).toMatchObject({ state: "empty", rules: {}, mostAsked: [] });
  });

  it("lists the asks answered the same way, most asked first", async () => {
    trail([
      ...[1, 2, 3, 4].flatMap(() =>
        askAndAnswer(BASH, cmd("npm test"), "allow"),
      ),
      ...[1, 2, 3].flatMap(() =>
        askAndAnswer(BASH, cmd("npm run lint"), "allow"),
      ),
      // answered both ways: not offered
      ...askAndAnswer(BASH, cmd("npm run build"), "allow"),
      ...askAndAnswer(BASH, cmd("npm run build"), "allow"),
      ...askAndAnswer(BASH, cmd("npm run build"), "deny"),
      // too few
      ...askAndAnswer(BASH, cmd("npm run typecheck"), "allow"),
    ]);
    updateIndex(dir, { now: NOW });
    const o = await auditOverview({ rules: [] }, host());
    expect(o.mostAsked.map((r) => [r.rule, r.answer, r.asks])).toEqual([
      ["runTerminalCommand(npm test)", "allow", 4],
      ["runTerminalCommand(npm run lint)", "allow", 3],
    ]);
  });

  it("does not offer what the guards of audit suggest withhold", async () => {
    trail([
      ...[1, 2, 3].flatMap(() =>
        askAndAnswer(BASH, cmd("rm -rf build"), "allow"),
      ),
      ...[1, 2, 3].flatMap(() =>
        askAndAnswer(BASH, cmd("curl https://example.test/x"), "allow"),
      ),
      ...[1, 2, 3].flatMap(() =>
        askAndAnswer("read_file", { filepath: ".env" }, "allow"),
      ),
      ...[1, 2, 3].flatMap(() =>
        askAndAnswer(BASH, cmd("npm run lint"), "allow"),
      ),
    ]);
    updateIndex(dir, { now: NOW });
    const o = await auditOverview({ rules: [] }, host());
    expect(o.mostAsked.map((r) => r.rule)).toEqual([
      "runTerminalCommand(npm run lint)",
    ]);
  });

  it("does not offer an allow for a call the person's own ask rule settles", async () => {
    trail(
      [1, 2, 3].flatMap(() => askAndAnswer(BASH, cmd("npm test"), "allow")),
    );
    updateIndex(dir, { now: NOW });
    const sources: RuleSourcesInput = {
      ...SOURCES,
      user: { ask: ["runTerminalCommand(npm test)"] },
    };
    const o = await auditOverview({ rules: [] }, host(sources));
    expect(o.mostAsked).toEqual([]);
  });

  it("marks a partly read audit, and hints only with history", () => {
    const o = buildOverview(undefined, ["runTerminalCommand(a*)"], NOW);
    expect(o.state).toBe("empty");
    expect(o.partial).toBe(true);
  });

  it("returns masked text only", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    trail(
      [1, 2, 3].flatMap(() =>
        askAndAnswer(BASH, cmd(`echo ${secret}`), "allow"),
      ),
    );
    updateIndex(dir, { now: NOW });
    const o = await auditOverview({ rules: [] }, host());
    expect(JSON.stringify(o)).not.toContain(secret);
  });
});
