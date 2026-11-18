import { describe, expect, it } from "vitest";

import {
  appendChunk,
  CaptureState,
  compressProgress,
  DEFAULT_OUTPUT_LIMITS,
  formatBytes,
  fullText,
  modelText,
  newCapture,
  omittedChars,
  OutputLimits,
  outputStats,
  RunawayReason,
  runawayMessage,
  viewText,
  withRunaway,
} from "./commandOutputBuffer";

/** Small limits, so tests can cross them with little text. */
const SMALL: OutputLimits = {
  ...DEFAULT_OUTPUT_LIMITS,
  headChars: 10,
  tailChars: 40,
  modelChars: 60,
  modelFailureChars: 30,
  floodBytesPerSecond: 100,
  floodSeconds: 3,
  floodTotalBytes: 10_000,
  repeatedLine: 5,
  repeatedBlockMaxLines: 4,
  repeatedBlockTimes: 3,
  viewLines: 3,
  viewChars: 1_000,
};

function feed(
  chunks: string[],
  limits: OutputLimits = SMALL,
  start = 0,
  stepMs = 0,
): CaptureState {
  let state = newCapture(start);
  chunks.forEach((c, i) => {
    state = appendChunk(state, c, c.length, start + i * stepMs, limits);
  });
  return state;
}

describe("appendChunk: what is kept", () => {
  it("keeps everything while it fits", () => {
    const s = feed(["hello\n", "world\n"]);
    expect(fullText(s)).toBe("hello\nworld\n");
    expect(omittedChars(s)).toBe(0);
    expect(s.totalChars).toBe(12);
    expect(s.totalBytes).toBe(12);
    expect(s.lines).toBe(2);
  });

  it("keeps the head whole and a bounded tail, and counts the rest", () => {
    const s = feed(["0123456789", "x".repeat(1000), "END"]);
    expect(s.head).toBe("0123456789");
    expect(s.tail.endsWith("END")).toBe(true);
    expect(s.tail.length).toBeLessThanOrEqual(SMALL.tailChars * 1.25);
    expect(omittedChars(s)).toBe(s.totalChars - s.head.length - s.tail.length);
    expect(fullText(s)).toBeUndefined();
  });

  it("memory stays bounded however much is printed", () => {
    let s = newCapture(0);
    for (let i = 0; i < 5_000; i++) {
      s = appendChunk(s, `line ${i} ${"y".repeat(50)}\n`, 60, i, SMALL);
    }
    expect(s.head.length + s.tail.length).toBeLessThanOrEqual(
      SMALL.headChars + SMALL.tailChars * 1.25 + 70,
    );
    expect(s.recent.length).toBeLessThanOrEqual(SMALL.repeatedBlockMaxLines);
    expect(s.lines).toBe(5_000);
  });

  it("splits a chunk across the head and the tail", () => {
    const s = feed(["0123456", "789abc"]);
    expect(s.head).toBe("0123456789");
    expect(s.tail).toBe("abc");
  });

  it("counts lines across chunk boundaries", () => {
    const s = feed(["par", "tial\nnext", "\n"]);
    expect(s.lines).toBe(2);
  });
});

describe("appendChunk: floods", () => {
  it("is a flood after enough seconds in a row at the rate", () => {
    // 150 bytes in each of seconds 0..3; the 4th second's start closes the 3rd
    let s = newCapture(0);
    for (let sec = 0; sec <= 3; sec++) {
      s = appendChunk(s, "a".repeat(150), 150, sec * 1000, SMALL);
    }
    expect(s.runaway).toBe(RunawayReason.Flood);
  });

  it("is not a flood when a slow second breaks the run", () => {
    let s = newCapture(0);
    const per = [150, 150, 10, 150, 150];
    per.forEach((bytes, sec) => {
      s = appendChunk(s, "a".repeat(bytes), bytes, sec * 1000, SMALL);
    });
    expect(s.runaway).toBeUndefined();
  });

  it("a gap of more than a second starts the run again", () => {
    let s = newCapture(0);
    for (const sec of [0, 1, 5, 6]) {
      s = appendChunk(s, "a".repeat(150), 150, sec * 1000, SMALL);
    }
    expect(s.floodRun).toBeLessThan(SMALL.floodSeconds);
    expect(s.runaway).toBeUndefined();
  });

  it("is a flood past the total, at any rate", () => {
    let s = newCapture(0);
    for (let i = 0; i < 11; i++) {
      s = appendChunk(s, "a", 1_000, i * 60_000, SMALL);
    }
    expect(s.runaway).toBe(RunawayReason.Flood);
  });

  it("reports the rate of the last whole second", () => {
    let s = newCapture(0);
    s = appendChunk(s, "a".repeat(80), 80, 0, SMALL);
    s = appendChunk(s, "a", 1, 1000, SMALL);
    expect(outputStats(s).bytesPerSecond).toBe(80);
  });
});

describe("appendChunk: loops", () => {
  it("the same line over and over is a loop", () => {
    const s = feed(Array(5).fill("retrying...\n"));
    expect(s.runaway).toBe(RunawayReason.Repetition);
  });

  it("one line fewer than the limit is not", () => {
    const s = feed(Array(4).fill("retrying...\n"));
    expect(s.runaway).toBeUndefined();
  });

  it("a block of lines repeating is a loop", () => {
    // p=2 needs 2 * 3 = 6 matching lines after the first block
    const s = feed(Array(5).fill("connect\nfailed\n"));
    expect(s.runaway).toBe(RunawayReason.Repetition);
  });

  it("varied output is not a loop", () => {
    const s = feed(
      Array.from({ length: 50 }, (_, i) => `test ${i} ok\n`),
      {
        ...SMALL,
        floodTotalBytes: 1e9,
      },
    );
    expect(s.runaway).toBeUndefined();
  });

  it("a progress bar redrawn with carriage returns counts as its last state", () => {
    const s = feed(["10%\r20%\r30%\n", "done\n"]);
    expect(s.runaway).toBeUndefined();
    expect(s.lines).toBe(2);
  });

  it("the first reason found is kept", () => {
    let s = feed(Array(5).fill("again\n"));
    s = withRunaway(s, RunawayReason.FileCap);
    expect(s.runaway).toBe(RunawayReason.Repetition);
  });
});

describe("compressProgress", () => {
  it("keeps a progress bar's last state", () => {
    expect(
      compressProgress(
        "Downloading 10%\rDownloading 55%\rDownloading 100%\nok",
      ),
    ).toBe("Downloading 100%\nok");
  });

  it("applies backspaces", () => {
    expect(compressProgress("ab\bc\n")).toBe("ac\n");
  });

  it("turns Windows line ends into plain ones", () => {
    expect(compressProgress("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  it("collapses a run of 3 or more equal lines", () => {
    expect(compressProgress("a\nb\nb\nb\nb\nc\n")).toBe(
      "a\nb\n[the line above repeated 3 more times]\nc\n",
    );
  });

  it("leaves two equal lines alone", () => {
    expect(compressProgress("x\nx\ny")).toBe("x\nx\ny");
  });

  it("leaves empty text alone", () => {
    expect(compressProgress("")).toBe("");
  });
});

describe("modelText", () => {
  it("is the whole output when it fits", () => {
    const s = feed(["all of it\n"]);
    expect(modelText(s, { failed: false, limits: SMALL })).toBe("all of it\n");
  });

  it("past the limit: a note, the start and the end", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
    const s = feed([lines], { ...SMALL, headChars: 1000, tailChars: 1000 });
    const out = modelText(s, {
      failed: false,
      outputPath: "/tmp/out.log",
      commandId: "cmd-7",
      limits: { ...SMALL, headChars: 1000, tailChars: 1000 },
    });
    expect(out).toMatch(/^\[Output cut: /);
    expect(out).toContain("/tmp/out.log");
    expect(out).toContain("read_command_output (id cmd-7)");
    expect(out).toContain("row 0");
    expect(out).toContain("row 39");
    expect(out).not.toContain("row 20\n");
  });

  it("a failure gets the smaller limit", () => {
    const text = "e".repeat(45);
    const s = feed([text], { ...SMALL, headChars: 100, tailChars: 100 });
    const limits = { ...SMALL, headChars: 100, tailChars: 100 };
    expect(modelText(s, { failed: false, limits })).toBe(text);
    expect(modelText(s, { failed: true, limits })).toMatch(/^\[Output cut/);
  });

  it("marks where the middle was not kept", () => {
    const s = feed(["HEAD567890", "m".repeat(500), "\nlast line"]);
    const out = modelText(s, {
      failed: false,
      limits: { ...SMALL, modelChars: 10_000 },
    });
    expect(out).toContain("characters not kept");
    expect(out).toContain("HEAD567890");
    expect(out).toContain("last line");
  });

  it("says nothing about a file when there is none", () => {
    const s = feed(["z".repeat(200)], {
      ...SMALL,
      headChars: 300,
      tailChars: 300,
    });
    const out = modelText(s, {
      failed: false,
      limits: { ...SMALL, headChars: 300, tailChars: 300 },
    });
    expect(out).not.toContain("full output is in");
  });
});

describe("viewText", () => {
  it("shows the last lines only", () => {
    const s = feed(["1\n2\n3\n4\n5"], {
      ...SMALL,
      headChars: 100,
      tailChars: 100,
    });
    const out = viewText(s, { ...SMALL, headChars: 100, tailChars: 100 });
    expect(out).toBe("[earlier output not shown here]\n3\n4\n5");
  });

  it("shows short output as it is", () => {
    const s = feed(["a\nb"]);
    expect(viewText(s, SMALL)).toBe("a\nb");
  });
});

describe("formatBytes and runawayMessage", () => {
  it("formats sizes", () => {
    expect(formatBytes(12)).toBe("12 bytes");
    expect(formatBytes(4_500)).toBe("5 KB");
    expect(formatBytes(38_200_000)).toBe("38.2 MB");
    expect(formatBytes(2_100_000_000)).toBe("2.1 GB");
  });

  it("names each reason in plain words", () => {
    const loop = feed(Array(5).fill("again\n"));
    expect(runawayMessage(RunawayReason.Repetition, loop, SMALL)).toMatch(
      /same line over and over/,
    );
    const big = { ...loop, totalBytes: 20_000 };
    expect(runawayMessage(RunawayReason.Flood, big, SMALL)).toMatch(
      /more than the/,
    );
    expect(runawayMessage(RunawayReason.Flood, loop, SMALL)).toMatch(
      /a second for 3 seconds/,
    );
    expect(runawayMessage(RunawayReason.FileCap, loop, SMALL)).toMatch(
      /limit of its file/,
    );
  });
});
