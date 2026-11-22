import { describe, expect, it } from "vitest";
import type { ChatMessage, ILLM } from "../../..";
import { BuiltInToolNames } from "../../../tools/builtIn";
import {
  failedCallOf,
  GUIDANCE_CASES,
  type GuidanceCase,
} from "./guidanceCases";
import {
  formatReplayReport,
  invalidCall,
  REPLAY_TEMPERATURE,
  replayMessages,
  runGuidanceReplay,
  scoreNextCall,
  summarizeReplay,
} from "./guidanceReplay";
import type { ScoredCall } from "./runner";
import { repeatModel, replayOracleModel, textOnlyModel } from "./stubs";

const byClass = (failureClass: string): GuidanceCase => {
  const c = GUIDANCE_CASES.find((x) => x.failureClass === failureClass);
  if (!c) throw new Error(`no case of class ${failureClass}`);
  return c;
};

const call = (name: string, args: Record<string, unknown>): ScoredCall => ({
  name,
  args,
});

const read = (filepath: string) =>
  call(BuiltInToolNames.ReadFile, { filepath });

describe("guidance cases", () => {
  it("cover the three classes, each ending in a call with an old and a new result", () => {
    expect(GUIDANCE_CASES.map((c) => c.failureClass)).toEqual([
      "edit-not-found",
      "question-cap",
      "unknown-tool",
    ]);
    expect(new Set(GUIDANCE_CASES.map((c) => c.id)).size).toBe(
      GUIDANCE_CASES.length,
    );
    for (const c of GUIDANCE_CASES) {
      expect(failedCallOf(c).name, c.id).not.toBe("");
      expect(Object.keys(c.arms), c.id).toEqual(
        expect.arrayContaining(["old", "new"]),
      );
      for (const text of Object.values(c.arms)) expect(text).not.toBe("");
    }
  });

  it("the old arms are the wording before 2026-11-22, and the new arms are not", () => {
    const tail = "Please try something else or request further instructions.";
    const edit = byClass("edit-not-found");
    expect(edit.arms.old).toMatch(
      /^single_find_and_replace failed because the arguments were invalid, with the following message: Edit at index 0: string not found in file/,
    );
    expect(edit.arms.old.endsWith(tail)).toBe(true);
    expect(edit.arms.new).toMatch(
      /^single_find_and_replace did not change src\/strings\.js: the old text was not found in the file\./,
    );
    expect(edit.arms.new).not.toContain(tail);
    // Both arms carry the search's own detail; only the frame differs
    expect(edit.arms.new).toContain("Edit at index 0: string not found");

    const unknown = byClass("unknown-tool");
    expect(unknown.arms.old).toBe(
      `Read failed because the arguments were invalid, with the following message: Tool Read not found\n\n${tail}`,
    );
    expect(unknown.arms.new).toMatch(/^There is no tool named Read\./);
    for (const t of unknown.tools) {
      expect(unknown.arms.new).toContain(t.function.name);
    }

    const cap = byClass("question-cap");
    expect(cap.arms.old).toMatch(/^This call needs the person's approval/);
    expect(cap.arms.new).toMatch(/^This call needs the person's approval/);
    expect(cap.arms.new).toContain("open questions");
  });

  it("the edit case's old text is in what the model read and not in the file now", () => {
    const c = byClass("edit-not-found");
    const old = String(failedCallOf(c).args.old_string);
    const readResult = c.messages.find((m) => m.role === "tool");
    expect(String(readResult?.content)).toContain(old);
    expect(c.project["src/strings.js"]).not.toContain(old);
  });

  it("the cap case holds four calls as questions before the one that meets the cap", () => {
    const c = byClass("question-cap");
    const held = c.messages.filter(
      (m) =>
        m.role === "tool" && /held as question q\d+/.test(String(m.content)),
    );
    expect(held).toHaveLength(4);
    expect(failedCallOf(c).name).toBe(BuiltInToolNames.RunTerminalCommand);
  });

  it("every oracle call is changed, valid and succeeds", () => {
    for (const c of GUIDANCE_CASES) {
      const o = c.oracle.toolCalls![0];
      const score = scoreNextCall(c, [
        call(o.function!.name!, JSON.parse(o.function!.arguments!)),
      ]);
      expect(score, c.id).toEqual({
        called: true,
        changed: true,
        valid: true,
        succeeded: true,
      });
    }
  });
});

describe("invalidCall", () => {
  const tools = byClass("question-cap").tools;

  it("accepts a call that fits the schema", () => {
    expect(invalidCall(read("src/strings.js"), tools)).toBeUndefined();
    expect(
      invalidCall(
        call(BuiltInToolNames.FinishItem, {
          outcome: "waiting",
          summary: "npm test needs approval",
        }),
        tools,
      ),
    ).toBeUndefined();
  });

  it("names what is wrong", () => {
    expect(invalidCall(call("Read", { file_path: "a" }), tools)).toContain(
      "not an offered tool",
    );
    expect(invalidCall(call(BuiltInToolNames.ReadFile, {}), tools)).toBe(
      "filepath is missing",
    );
    expect(
      invalidCall(call(BuiltInToolNames.ReadFile, { filepath: 3 }), tools),
    ).toBe("filepath is not of type string");
    expect(
      invalidCall(
        call(BuiltInToolNames.FinishItem, { outcome: "paused", summary: "x" }),
        tools,
      ),
    ).toBe("outcome is not one of its allowed values");
    expect(
      invalidCall(call(BuiltInToolNames.ReadFile, { _raw: "{" }), tools),
    ).toBe("the arguments are not a JSON object");
  });
});

describe("scoreNextCall", () => {
  it("no call counts against all three", () => {
    expect(scoreNextCall(byClass("unknown-tool"), [])).toEqual({
      called: false,
      changed: false,
      valid: false,
      succeeded: false,
    });
  });

  it("the same call again is not changed, whatever the order of its keys", () => {
    const c = byClass("edit-not-found");
    const failed = failedCallOf(c);
    const reordered = Object.fromEntries(Object.entries(failed.args).reverse());
    const score = scoreNextCall(c, [call(failed.name, reordered)]);
    expect(score.changed).toBe(false);
    // An offered tool with fitting arguments, sent at a file that still lacks the text
    expect(score.valid).toBe(true);
    expect(score.succeeded).toBe(false);
  });

  it("edit class: a re-read succeeds, and so does an edit whose old text is in the file now", () => {
    const c = byClass("edit-not-found");
    expect(scoreNextCall(c, [read("src/strings.js")]).succeeded).toBe(true);
    expect(scoreNextCall(c, [read("./src/strings.js")]).succeeded).toBe(true);
    expect(
      scoreNextCall(c, [
        call(BuiltInToolNames.SingleFindAndReplace, {
          filepath: "src/strings.js",
          old_string: 'tail = "\\u2026"',
          new_string: 'tail = "..."',
        }),
      ]).succeeded,
    ).toBe(true);
    expect(
      scoreNextCall(c, [
        call(BuiltInToolNames.MultiEdit, {
          filepath: "src/strings.js",
          edits: [
            { old_string: 'tail = "\\u2026"', new_string: 'tail = "..."' },
          ],
        }),
      ]).succeeded,
    ).toBe(true);
  });

  it("edit class: another miss, a read of another file and a whole-file write do not succeed", () => {
    const c = byClass("edit-not-found");
    const miss = scoreNextCall(c, [
      call(BuiltInToolNames.SingleFindAndReplace, {
        filepath: "src/strings.js",
        old_string: "const nothing = like(this);",
        new_string: "x",
      }),
    ]);
    expect(miss).toMatchObject({
      changed: true,
      valid: true,
      succeeded: false,
    });
    expect(scoreNextCall(c, [read("package.json")]).succeeded).toBe(false);
    expect(
      scoreNextCall(c, [
        call(BuiltInToolNames.CreateNewFile, {
          filepath: "src/strings.js",
          contents: "export {};\n",
        }),
      ]),
    ).toMatchObject({ changed: true, valid: true, succeeded: false });
  });

  it("unknown tool: only the real read of the file succeeds", () => {
    const c = byClass("unknown-tool");
    expect(scoreNextCall(c, [read("src/strings.js")]).succeeded).toBe(true);
    // Another wrong name: changed, and still not a tool
    const other = scoreNextCall(c, [call("cat", { path: "src/strings.js" })]);
    expect(other).toMatchObject({
      changed: true,
      valid: false,
      succeeded: false,
    });
    expect(other.invalid).toContain("not an offered tool");
    // The right tool with the wrong parameter name
    expect(
      scoreNextCall(c, [
        call(BuiltInToolNames.ReadFile, { file_path: "src/strings.js" }),
      ]),
    ).toMatchObject({ changed: true, valid: false, succeeded: false });
    expect(
      scoreNextCall(c, [call(BuiltInToolNames.LSTool, { dirPath: "src" })]),
    ).toMatchObject({ valid: true, succeeded: false });
  });

  it("question cap: another command or another question does not succeed; work that needs no approval and the waiting report do", () => {
    const c = byClass("question-cap");
    const another = scoreNextCall(c, [
      call(BuiltInToolNames.RunTerminalCommand, { command: "yarn test" }),
    ]);
    expect(another).toMatchObject({
      changed: true,
      valid: true,
      succeeded: false,
    });
    expect(
      scoreNextCall(c, [
        call(BuiltInToolNames.HoldQuestion, {
          question: "May I run npm test?",
          kind: "blocking",
        }),
      ]),
    ).toMatchObject({ valid: true, succeeded: false });
    expect(scoreNextCall(c, [read("src/strings.js")]).succeeded).toBe(true);
    expect(
      scoreNextCall(c, [
        call(BuiltInToolNames.FinishItem, {
          outcome: "waiting",
          summary: "The test command needs approval",
        }),
      ]).succeeded,
    ).toBe(true);
  });

  it("scores the first call of a reply", () => {
    const c = byClass("unknown-tool");
    expect(
      scoreNextCall(c, [
        call("cat", { path: "src/strings.js" }),
        read("src/strings.js"),
      ]).succeeded,
    ).toBe(false);
  });
});

describe("replay run (stand-ins, no network)", () => {
  it("sends the case's history with the arm's text as the result of the failed call", async () => {
    const seen: ChatMessage[][] = [];
    const temperatures: unknown[] = [];
    const spy: Pick<ILLM, "chat"> = {
      chat: async (messages, _signal, options) => {
        seen.push(messages);
        temperatures.push(options?.temperature);
        return { role: "assistant", content: "" };
      },
    };
    const c = byClass("unknown-tool");
    await runGuidanceReplay(spy, { cases: [c], concurrency: 1 });
    expect(seen).toHaveLength(2);
    const lasts = seen.map((m) => m[m.length - 1]);
    expect(lasts.map((m) => m.content)).toEqual([c.arms.old, c.arms.new]);
    for (const last of lasts) {
      expect(last).toMatchObject({ role: "tool", toolCallId: "u1" });
    }
    expect(seen[0][0].role).toBe("system");
    expect(seen[0].slice(1, -1)).toEqual(c.messages);
    expect(replayMessages(c, "old", "s")).toHaveLength(c.messages.length + 2);
    expect(temperatures).toEqual([REPLAY_TEMPERATURE, REPLAY_TEMPERATURE]);
  });

  it("the oracle scores every trial of every arm on all three", async () => {
    const trials = await runGuidanceReplay(replayOracleModel(GUIDANCE_CASES), {
      trials: 3,
    });
    const rows = summarizeReplay(trials);
    expect(rows.map((r) => `${r.failureClass}/${r.arm}`)).toEqual([
      "edit-not-found/old",
      "edit-not-found/new",
      "question-cap/old",
      "question-cap/new",
      "question-cap/proposed",
      "unknown-tool/old",
      "unknown-tool/new",
    ]);
    for (const r of rows) {
      expect(r.n).toBe(3);
      expect([r.changed.count, r.valid.count, r.succeeded.count]).toEqual([
        3, 3, 3,
      ]);
      expect(r.noCall).toBe(0);
      // 3 of 3 is 44 to 100, not 100 to 100
      expect(r.succeeded.low).toBeCloseTo(0.4385, 3);
      expect(r.succeeded.high).toBe(1);
    }
  });

  it("the repeat stand-in changes nothing and succeeds nowhere", async () => {
    const rows = summarizeReplay(
      await runGuidanceReplay(repeatModel, { trials: 2 }),
    );
    for (const r of rows) {
      expect(r.changed.count, r.failureClass).toBe(0);
      expect(r.succeeded.count, r.failureClass).toBe(0);
      // The unknown name is still unknown; the other two repeat a real tool
      expect(r.valid.count, r.failureClass).toBe(
        r.failureClass === "unknown-tool" ? 0 : 2,
      );
    }
  });

  it("a reply with no call, and a model call that fails, count as no call", async () => {
    const text = summarizeReplay(await runGuidanceReplay(textOnlyModel));
    for (const r of text) {
      expect([r.changed.count, r.valid.count, r.succeeded.count]).toEqual([
        0, 0, 0,
      ]);
      expect(r.noCall).toBe(1);
      expect(r.errors).toBe(0);
    }
    const failing: Pick<ILLM, "chat"> = {
      chat: async () => {
        throw new Error("HTTP 500");
      },
    };
    const trials = await runGuidanceReplay(failing, {
      cases: [byClass("unknown-tool")],
    });
    expect(summarizeReplay(trials).map((r) => [r.noCall, r.errors])).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(formatReplayReport("m", trials)).toContain(
      "2 model call(s) failed and are counted as no call: HTTP 500",
    );
  });
});

describe("replay report", () => {
  it("is one table with a row per class and arm and an interval on every rate", async () => {
    const trials = await runGuidanceReplay(replayOracleModel(GUIDANCE_CASES), {
      trials: 10,
    });
    const report = formatReplayReport("stub:oracle", trials, { stub: true });
    expect(report).toContain("## Guidance replay: stub:oracle");
    expect(report).toContain(
      "| Class | Arm | N | Changed | Valid | Succeeded | No call |",
    );
    expect(report).toContain(
      "| edit-not-found | new | 10 | 10/10 (72 to 100%) | 10/10 (72 to 100%) | 10/10 (72 to 100%) | 0 |",
    );
    expect(report.match(/^\| (edit|question|unknown)/gm)).toHaveLength(7);
    expect(report).toContain("says nothing about any wording");
  });

  it("says what the number of trials supports", async () => {
    const oracle = replayOracleModel(GUIDANCE_CASES);
    const at = async (trials: number) =>
      formatReplayReport("m", await runGuidanceReplay(oracle, { trials }), {
        temperature: 0.7,
      });
    expect(await at(3)).toContain("too few to compare arms");
    const ten = await at(10);
    expect(ten).toContain("N is 10 per arm at the least, which is small");
    expect(ten).toContain("Temperature 0.7");
    expect(await at(33)).toContain("enough to tell a 0.3 difference");
  });
});
