import { beforeEach, describe, expect, it } from "vitest";
import {
  callText,
  recordRefusal,
  recordResult,
  REPEAT_REFUSAL_LIMIT,
  REPEAT_RESULT_LIMIT,
  refusalSteer,
  resetRepeatGuard,
  resultSteer,
  sameCall,
} from "./repeatGuard";

const CMD = "run_terminal_command";
const long = (tail: string) =>
  `cd D:\\code\\gta6; python -c "import re,sys;sys.path.insert(0,'.');from gta6.config import load_paths; p=load_paths(); print(p.game_exe, ${tail})"`;

beforeEach(() => resetRepeatGuard());

describe("calls that are the same", () => {
  it("a command with other spacing is the same command", () => {
    expect(
      sameCall(CMD, callText(CMD, { command: "git  status " }), "git status"),
    ).toBe(true);
  });

  it("a long command rewritten a little is the same command", () => {
    expect(
      sameCall(
        CMD,
        callText(CMD, { command: long("1") }),
        callText(CMD, { command: long("2") }),
      ),
    ).toBe(true);
  });

  it("a short command that differs is a different command", () => {
    expect(sameCall(CMD, "git status", "git diff")).toBe(false);
  });

  it("a different tool is never the same call", () => {
    expect(sameCall("read_file", "{}", "{}", CMD)).toBe(false);
  });
});

describe("a call that was refused and comes back", () => {
  it("says nothing the first time", () => {
    expect(
      refusalSteer(recordRefusal("s", CMD, { command: long("1") }, "c1")),
    ).toBeNull();
  });

  it("names another way the second time, for a small rewrite too", () => {
    recordRefusal("s", CMD, { command: long("1") }, "c1");
    const count = recordRefusal("s", CMD, { command: long("2") }, "c2");
    expect(count).toBe(REPEAT_REFUSAL_LIMIT);
    const note = refusalSteer(count)!;
    expect(note).toContain("2 times in a row");
    expect(note).toContain("create_new_file");
    expect(note).toContain("refused the same way");
  });

  it("counts a re-evaluation of one call once", () => {
    recordRefusal("s", CMD, { command: long("1") }, "c1");
    expect(recordRefusal("s", CMD, { command: long("1") }, "c1")).toBe(1);
  });

  it("starts again after a different call", () => {
    recordRefusal("s", CMD, { command: long("1") }, "c1");
    recordResult("s", "read_file", { filepath: "a.ts" }, "text", "c2");
    expect(recordRefusal("s", CMD, { command: long("1") }, "c3")).toBe(1);
  });

  it("keeps each session to itself", () => {
    recordRefusal("a", CMD, { command: long("1") }, "c1");
    expect(recordRefusal("b", CMD, { command: long("1") }, "c2")).toBe(1);
  });
});

describe("a call that ran with the same result again", () => {
  it("says nothing before the limit", () => {
    for (let i = 1; i < REPEAT_RESULT_LIMIT; i++) {
      const count = recordResult(
        "s",
        CMD,
        { command: "pytest -q" },
        "1 failed",
        `c${i}`,
      );
      expect(resultSteer(count)).toBeNull();
    }
  });

  it("says 'You just ran that same command N times' at the limit", () => {
    let count = 0;
    for (let i = 1; i <= REPEAT_RESULT_LIMIT; i++) {
      count = recordResult(
        "s",
        CMD,
        { command: "pytest -q" },
        "1 failed",
        `c${i}`,
      );
    }
    const note = resultSteer(count)!;
    expect(note).toContain(
      `You just ran that same command ${REPEAT_RESULT_LIMIT} times`,
    );
    expect(note).toContain("grep_search");
  });

  it("does not count a command that gave a different result each time", () => {
    for (let i = 1; i <= 5; i++) {
      const count = recordResult(
        "s",
        CMD,
        { command: "tail -n 5 app.log" },
        `line ${i}`,
        `c${i}`,
      );
      expect(count).toBe(1);
    }
  });

  it("does not count the same command with other calls in between", () => {
    recordResult("s", CMD, { command: "pytest -q" }, "1 failed", "c1");
    recordResult("s", "edit_existing_file", { filepath: "a.py" }, "ok", "c2");
    expect(
      recordResult("s", CMD, { command: "pytest -q" }, "1 failed", "c3"),
    ).toBe(1);
  });
});
