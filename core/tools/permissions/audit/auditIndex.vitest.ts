import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INDEX_FILE,
  MAX_INDEX_BYTES,
  readIndex,
  updateIndex,
  writeIndex,
  emptyIndex,
} from "./auditIndex";
import {
  askAndAnswer,
  decisionEvent,
  jsonl,
  resetSeq,
  sessionFile,
  T0,
} from "./auditIndexFixtures";

const NOW = new Date(T0 + 3 * 86_400_000);
const BASH = "run_terminal_command";
const cmd = (command: string) => ({ command });
let dir: string;

beforeEach(() => {
  resetSeq();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-index-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function day(index: ReturnType<typeof updateIndex>["index"], key: string) {
  return index.calls[key]?.days["2026-11-01"];
}

describe("the audit index", () => {
  it("counts asks and who answered, per call shape and per day", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(
      file,
      jsonl([
        ...askAndAnswer(BASH, cmd("npm test"), "allow"),
        ...askAndAnswer(BASH, cmd("npm test"), "allow"),
        ...askAndAnswer(BASH, cmd("npm test"), "deny"),
        decisionEvent("r1", BASH, cmd("npm test"), {
          policy: "allow",
          by: "reviewer",
          source: undefined,
        }),
      ]),
    );
    const { index } = updateIndex(dir, { now: NOW });
    // asks, allows, denies, allowed by the person, denied by the person, by the reviewer
    expect(day(index, "runTerminalCommand(npm test)")).toEqual([
      3, 0, 0, 2, 1, 0,
    ]);
    expect(index.since).toBe("2026-11-01");
    expect(index.complete).toBe(true);
  });

  it("counts a rule's asks and matches under the rule text", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(
      file,
      jsonl([
        decisionEvent("a", BASH, cmd("git push"), {
          rule: "runTerminalCommand(git push*)",
          source: "ask-rule",
        }),
        decisionEvent("b", BASH, cmd("git status"), {
          policy: "allow",
          rule: "runTerminalCommand(git status*)",
          source: "allow-rule",
        }),
        decisionEvent("c", BASH, cmd("git status"), {
          policy: "allow",
          rule: "runTerminalCommand(git status*)",
          source: "allow-rule",
        }),
      ]),
    );
    const { index } = updateIndex(dir, { now: NOW });
    expect(
      index.rules["runTerminalCommand(git push*)"].days["2026-11-01"],
    ).toEqual([1, 0, 0, 0, 0, 0]);
    expect(
      index.rules["runTerminalCommand(git status*)"].days["2026-11-01"],
    ).toEqual([0, 2, 0, 0, 0, 0]);
  });

  it("reads only the appended bytes on the next run", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(file, jsonl(askAndAnswer(BASH, cmd("npm test"), "allow")));
    const first = updateIndex(dir, { now: NOW });
    const size = fs.statSync(file).size;
    expect(first.stats.bytesRead).toBe(size);
    const idle = updateIndex(dir, { now: NOW });
    expect(idle.stats.bytesRead).toBe(0);
    const more = jsonl(askAndAnswer(BASH, cmd("npm test"), "allow"));
    fs.appendFileSync(file, more);
    const next = updateIndex(dir, { now: NOW });
    expect(next.stats.bytesRead).toBe(Buffer.byteLength(more));
    expect(next.stats.rebuilt).toBe(false);
    expect(day(next.index, "runTerminalCommand(npm test)")).toEqual([
      2, 0, 0, 2, 0, 0,
    ]);
  });

  it("leaves a half-written last line for the next run, and never counts it twice", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    const [a, b] = askAndAnswer(BASH, cmd("npm test"), "allow");
    const lineB = JSON.stringify(b);
    fs.writeFileSync(file, `${JSON.stringify(a)}\n${lineB.slice(0, 40)}`);
    const first = updateIndex(dir, { now: NOW });
    expect(day(first.index, "runTerminalCommand(npm test)")).toEqual([
      1, 0, 0, 0, 0, 0,
    ]);
    fs.appendFileSync(file, `${lineB.slice(40)}\n`);
    const second = updateIndex(dir, { now: NOW });
    expect(day(second.index, "runTerminalCommand(npm test)")).toEqual([
      1, 0, 0, 1, 0, 0,
    ]);
  });

  it("builds again from scratch when a file shrinks", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(
      file,
      jsonl([
        ...askAndAnswer(BASH, cmd("npm test"), "allow"),
        ...askAndAnswer(BASH, cmd("npm test"), "allow"),
      ]),
    );
    updateIndex(dir, { now: NOW });
    fs.writeFileSync(
      file,
      jsonl(askAndAnswer(BASH, cmd("npm run lint"), "allow")),
    );
    const { index, stats } = updateIndex(dir, { now: NOW });
    expect(stats.rebuilt).toBe(true);
    expect(index.calls["runTerminalCommand(npm test)"]).toBeUndefined();
    expect(day(index, "runTerminalCommand(npm run lint)")).toEqual([
      1, 0, 0, 1, 0, 0,
    ]);
  });

  it("builds again when a file was replaced by a longer one", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(file, jsonl(askAndAnswer(BASH, cmd("npm test"), "allow")));
    updateIndex(dir, { now: NOW });
    fs.writeFileSync(
      file,
      jsonl([
        ...askAndAnswer(BASH, cmd("npm run build"), "allow"),
        ...askAndAnswer(BASH, cmd("npm run build"), "allow"),
        ...askAndAnswer(BASH, cmd("npm run build"), "allow"),
      ]),
    );
    const { index, stats } = updateIndex(dir, { now: NOW });
    expect(stats.rebuilt).toBe(true);
    expect(index.calls["runTerminalCommand(npm test)"]).toBeUndefined();
    expect(day(index, "runTerminalCommand(npm run build)")).toEqual([
      3, 0, 0, 3, 0, 0,
    ]);
  });

  it("goes on in slices when a run is limited, and ends complete", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(...askAndAnswer(BASH, cmd(`npm run task${i % 4}`), "allow"));
    }
    fs.writeFileSync(file, jsonl(events));
    let r = updateIndex(dir, { now: NOW, maxBytes: 4000 });
    expect(r.index.complete).toBe(false);
    for (let i = 0; i < 100 && !r.index.complete; i++) {
      r = updateIndex(dir, { now: NOW, maxBytes: 4000 });
    }
    expect(r.index.complete).toBe(true);
    const total = Object.values(r.index.calls)
      .map((k) => k.days["2026-11-01"][0])
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(40);
  });

  it("stores masked keys only, never a raw argument", () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(
      file,
      jsonl([
        ...askAndAnswer(
          BASH,
          cmd(`curl -H "x-api-key: ${secret}" https://example.test`),
          "allow",
        ),
        ...askAndAnswer(BASH, cmd(`echo ${secret}`), "allow"),
        decisionEvent("r", BASH, cmd("x"), {
          rule: `runTerminalCommand(echo ${secret})`,
          source: "ask-rule",
        }),
      ]),
    );
    updateIndex(dir, { now: NOW });
    const text = fs.readFileSync(path.join(dir, INDEX_FILE), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("example.test");
    // a call with a masked value has no rule shape: the tool name only
    expect(text).toContain("tool:runTerminalCommand");
  });

  it("writes through a temporary file, leaves none behind, and is owner-only", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(file, jsonl(askAndAnswer(BASH, cmd("npm test"), "allow")));
    updateIndex(dir, { now: NOW });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dir, INDEX_FILE)).mode & 0o077).toBe(0);
    }
    expect(readIndex(dir)?.v).toBe(1);
  });

  it("two updates at once leave one whole index, and the next run catches up", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(file, jsonl(askAndAnswer(BASH, cmd("npm test"), "allow")));
    // both processes start from the same (empty) state and read the same bytes
    const a = updateIndex(dir, { now: NOW, write: false });
    const b = updateIndex(dir, { now: NOW, write: false });
    expect(writeIndex(dir, a.index)).toBe(true);
    expect(writeIndex(dir, b.index)).toBe(true);
    const stored = readIndex(dir)!;
    expect(
      stored.calls["runTerminalCommand(npm test)"].days["2026-11-01"],
    ).toEqual([1, 0, 0, 1, 0, 0]);
    fs.appendFileSync(
      file,
      jsonl(askAndAnswer(BASH, cmd("npm test"), "allow")),
    );
    const c = updateIndex(dir, { now: NOW });
    expect(day(c.index, "runTerminalCommand(npm test)")).toEqual([
      2, 0, 0, 2, 0, 0,
    ]);
  });

  it("is capped: the keys seen longest ago go first", () => {
    const index = emptyIndex(NOW);
    for (let i = 0; i < 12000; i++) {
      index.calls[`runTerminalCommand(${"x".repeat(150)} ${i})`] = {
        last: new Date(T0 + i * 1000).toISOString(),
        days: { "2026-11-01": [1, 0, 0, 1, 0, 0] },
      };
    }
    expect(writeIndex(dir, index)).toBe(true);
    const size = fs.statSync(path.join(dir, INDEX_FILE)).size;
    expect(size).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    const stored = readIndex(dir)!;
    expect(stored.trimmed).toBe(true);
    expect(Object.keys(stored.calls).some((k) => k.endsWith(" 11999)"))).toBe(
      true,
    );
    expect(Object.keys(stored.calls).some((k) => k.endsWith(" 0)"))).toBe(
      false,
    );
  });

  it("makes no folder and no file when there is no trail", () => {
    const missing = path.join(dir, "never");
    const { index, stats } = updateIndex(missing, { now: NOW });
    expect(stats.wrote).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
    expect(index.since).toBeUndefined();
  });

  it("drops day buckets older than 90 days and forgets files that are gone", () => {
    const file = sessionFile(dir, "2026-11", "s1");
    fs.writeFileSync(file, jsonl(askAndAnswer(BASH, cmd("npm test"), "allow")));
    updateIndex(dir, { now: NOW });
    fs.rmSync(file);
    const later = new Date(T0 + 120 * 86_400_000);
    const { index } = updateIndex(dir, { now: later });
    expect(index.calls).toEqual({});
    expect(index.files).toEqual({});
  });
});
