import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readNoticeState,
  recordLive,
  recordLiveMany,
} from "./retirementNoticeState.js";
import {
  configRetirementWarnings,
  currentNotice,
  dismissCurrentNotice,
  noticesFor,
  startupRetirementLine,
} from "./retirementStartup.js";

const file = () => join(mkdtempSync(join(tmpdir(), "startup-")), "n.json");
const sonnet = {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
};

describe("startupRetirementLine", () => {
  it("shows once a day, then again the next day", () => {
    const f = file();
    const a = startupRetirementLine({ ...sonnet, now: "2026-11-11", file: f });
    expect(a).toContain("retires on 2026-11-30");
    expect(a).toContain("claude-sonnet-5-5");
    expect(a).toContain("continuous dismiss-notice");
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-11-11", file: f }),
    ).toBeUndefined();
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-11-12", file: f }),
    ).toContain("retires on 2026-11-30");
  });

  it("stays hidden after a dismissal, and comes back when the notice changes", () => {
    const f = file();
    expect(
      dismissCurrentNotice({ ...sonnet, now: "2026-11-11", file: f }),
    ).toBe(true);
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-11-12", file: f }),
    ).toBeUndefined();
    // The model retired: a different severity is a different notice.
    expect(
      startupRetirementLine({ ...sonnet, now: "2026-12-02", file: f }),
    ).toContain("was retired");
  });

  it("says nothing for a current model or another provider", () => {
    const f = file();
    expect(
      startupRetirementLine({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        now: "2026-11-11",
        file: f,
      }),
    ).toBeUndefined();
    expect(
      startupRetirementLine({
        provider: "bedrock",
        model: "claude-sonnet-4-5-20250929",
        now: "2026-11-11",
        file: f,
      }),
    ).toBeUndefined();
    expect(
      dismissCurrentNotice({ provider: "openai", model: "gpt-5", file: f }),
    ).toBe(false);
  });

  it("uses the lifecycle the user's key last returned", () => {
    const f = file();
    recordLive(
      sonnet.model,
      { lifecycle: "deprecated", retiresAt: "2026-12-15T00:00:00Z" },
      "2026-11-10",
      f,
    );
    expect(
      currentNotice({ ...sonnet, now: "2026-11-11", file: f }),
    ).toMatchObject({ from: "live", retiresAt: "2026-12-15" });
  });

  it("never throws on an unwritable state file", () => {
    // A path below a regular file cannot be created on any platform (a
    // drive-letter path is only unwritable on Windows).
    const blocker = join(mkdtempSync(join(tmpdir(), "startup-")), "plain");
    writeFileSync(blocker, "");
    expect(
      startupRetirementLine({
        ...sonnet,
        now: "2026-11-11",
        file: join(blocker, "dir", "n.json"),
      }),
    ).toContain("retires");
  });
});

describe("noticesFor (picker and Settings > Models)", () => {
  it("returns each listed model once, from the table when nothing was fetched", () => {
    const f = file();
    const got = noticesFor(
      [
        sonnet,
        sonnet,
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        {
          provider: "bedrock",
          model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        },
      ],
      { now: "2026-11-14", file: f },
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      provider: "anthropic",
      model: sonnet.model,
      notice: {
        from: "table",
        severity: "retiring",
        retiresAt: "2026-11-30",
        daysLeft: 16,
        replacement: "claude-sonnet-5-5",
      },
    });
  });

  it("is not hidden by a dismissal of the chip", () => {
    const f = file();
    dismissCurrentNotice({ ...sonnet, now: "2026-11-14", file: f });
    expect(noticesFor([sonnet], { now: "2026-11-14", file: f })).toHaveLength(
      1,
    );
  });

  it("uses a fetched list's lifecycle for a model the table does not know", () => {
    const f = file();
    recordLiveMany(
      [
        {
          model: "claude-future-1",
          live: { lifecycle: "deprecated", retiresAt: "2026-12-20T00:00:00Z" },
        },
      ],
      "2026-11-14",
      f,
    );
    const [n] = noticesFor(
      [{ provider: "anthropic", model: "claude-future-1" }],
      { now: "2026-11-14", file: f },
    );
    expect(n.notice).toMatchObject({
      from: "live",
      severity: "retiring",
      retiresAt: "2026-12-20",
    });
  });
});

describe("configRetirementWarnings (config check)", () => {
  const configured = [
    { ...sonnet, title: "Sonnet" },
    // The same model under another role: one warning, not two
    { ...sonnet, title: "Sonnet" },
    { provider: "anthropic", model: "claude-sonnet-5-5", title: "New" },
    {
      provider: "bedrock",
      model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      title: "Bedrock Sonnet",
    },
  ];

  it("warns once per model with the date and the successor, then stays quiet", () => {
    const f = file();
    const first = configRetirementWarnings(configured, {
      now: "2026-11-14",
      file: f,
    });
    expect(first).toEqual([
      'Model "Sonnet": claude-sonnet-4-5-20250929 is deprecated and retires on 2026-11-30 (16 days). Suggested replacement: claude-sonnet-5-5.',
    ]);
    // Next load, same day or later: nothing new to say
    expect(
      configRetirementWarnings(configured, { now: "2026-11-14", file: f }),
    ).toEqual([]);
    expect(
      configRetirementWarnings(configured, { now: "2026-11-20", file: f }),
    ).toEqual([]);
  });

  it("warns again once the model has retired (past date, new severity)", () => {
    const f = file();
    configRetirementWarnings(configured, { now: "2026-11-14", file: f });
    const after = configRetirementWarnings(configured, {
      now: "2026-12-01",
      file: f,
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("was retired on 2026-11-30");
    expect(after[0]).toContain("claude-sonnet-5-5");
  });

  it("names a 'not sooner than' date as only that", () => {
    const f = file();
    const [w] = configRetirementWarnings(
      [{ provider: "anthropic", model: "claude-opus-4-5-20251101" }],
      { now: "2026-11-14", file: f },
    );
    expect(w).toContain("may retire from 2026-11-24");
    expect(w).toContain("claude-opus-5-5");
  });

  it("is quiet for a notice the person dismissed, and outside the window", () => {
    const f = file();
    dismissCurrentNotice({ ...sonnet, now: "2026-11-14", file: f });
    expect(
      configRetirementWarnings(configured, { now: "2026-11-14", file: f }),
    ).toEqual([]);
    expect(
      configRetirementWarnings(
        [{ provider: "anthropic", model: "claude-opus-4-5-20251101" }],
        { now: "2026-09-01", file: file() },
      ),
    ).toEqual([]);
  });

  it("records the warning in the state file", () => {
    const f = file();
    configRetirementWarnings([sonnet], { now: "2026-11-14", file: f });
    expect(Object.keys(readNoticeState(f).warned)).toEqual([
      "claude-sonnet-4-5-20250929@2026-11-30:retiring",
    ]);
  });
});
