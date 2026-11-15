import { allModelProviders, getAllRecommendedFor } from "@continuedev/llm-info";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findRetirementRow,
  liveFromFetched,
  RETIREMENT_ROWS,
  retirementNotice,
  rowStateOn,
} from "./modelRetirement.js";

const NOW = "2026-11-11";
const today = new Date().toISOString().slice(0, 10);
const note = (provider: string, model: string, now = NOW, live?: any) =>
  retirementNotice({ provider, model, now, live });

describe("the checked-in table", () => {
  it("carries a source URL and a fetch date on every row", () => {
    for (const r of RETIREMENT_ROWS) {
      expect(r.source, r.id).toMatch(/^https:\/\//);
      expect(r.fetchedOn, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(() => new RegExp(r.match, "i"), r.id).not.toThrow();
      expect(new RegExp(r.match, "i").test(r.id), r.id).toBe(true);
    }
  });

  it("agrees with itself: a row marked retired had its date by the time it was read", () => {
    for (const r of RETIREMENT_ROWS) {
      if (r.state !== "retired") continue;
      expect(r.retiresAt, r.id).toBeTruthy();
      expect(r.retiresAt! <= r.fetchedOn, r.id).toBe(true);
    }
  });

  describe("on either side of a firm date (fake clock)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const clockToday = () => new Date().toISOString().slice(0, 10);
    const sonnet45 = () => findRetirementRow("anthropic", "claude-sonnet-4-5")!;

    it("reads the row's own state before the date", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-29T12:00:00Z"));
      expect(rowStateOn(sonnet45(), clockToday())).toBe("deprecated");
      expect(
        note("anthropic", "claude-sonnet-4-5", clockToday()),
      ).toMatchObject({ severity: "retiring", daysLeft: 1 });
    });

    it("treats the model as retired from the date on, without editing the table", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      for (const day of ["2026-11-30T00:00:00Z", "2026-12-01T12:00:00Z"]) {
        vi.setSystemTime(new Date(day));
        expect(sonnet45().state).toBe("deprecated");
        expect(rowStateOn(sonnet45(), clockToday()), day).toBe("retired");
        expect(
          note("anthropic", "claude-sonnet-4-5", clockToday())?.severity,
          day,
        ).toBe("retired");
      }
    });

    it("never retires a model on a 'not sooner than' date", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
      const opus45 = findRetirementRow("anthropic", "claude-opus-4-5")!;
      expect(rowStateOn(opus45, clockToday())).toBe("active");
    });

    it("needs no catalog edit on the day: every model the table deprecates or retires is marked in llm-info", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      for (const day of [
        "2026-11-29T12:00:00Z",
        "2026-12-01T12:00:00Z",
        `${today}T12:00:00Z`,
      ]) {
        vi.setSystemTime(new Date(day));
        const stale: string[] = [];
        for (const p of allModelProviders) {
          if (p.id !== "anthropic") continue;
          for (const m of p.models) {
            const row = findRetirementRow("anthropic", m.model);
            if (!row) continue;
            if (rowStateOn(row, clockToday()) !== "active" && !m.lifecycle) {
              stale.push(`${m.model} (${rowStateOn(row, clockToday())})`);
            }
          }
        }
        expect(
          stale,
          `${day}: mark these with lifecycle in packages/llm-info`,
        ).toEqual([]);
      }
    });
  });

  it("does not recommend a retiring or retired model in the model catalog page", () => {
    const mdx = fs.readFileSync(
      path.resolve(__dirname, "../../docs/customize/model-catalog.mdx"),
      "utf8",
    );
    const ids = mdx.match(/claude-[a-z0-9.-]+/g) ?? [];
    for (const id of ids) {
      const n = note("anthropic", id.replace(/^us\.anthropic\./, ""), today);
      expect(n?.message, id).toBeUndefined();
    }
  });
});

describe("retirementNotice", () => {
  it("warns with the date and the replacement for Sonnet 4.5", () => {
    const n = note("anthropic", "claude-sonnet-4-5-20250929");
    expect(n).toMatchObject({
      severity: "retiring",
      retiresAt: "2026-11-30",
      daysLeft: 19,
      replacement: "claude-sonnet-5-5",
      from: "table",
      sourceUrl: expect.stringContaining("model-deprecations"),
    });
    expect(n?.message).toContain("2026-11-30");
    expect(n?.message).toContain("claude-sonnet-5-5");
  });

  it("matches the alias form too", () => {
    expect(note("anthropic", "claude-sonnet-4-5")?.severity).toBe("retiring");
  });

  it("says a 'not sooner than' date is only that", () => {
    const n = note("anthropic", "claude-opus-4-5");
    expect(n?.severity).toBe("possible");
    expect(n?.message).toContain("may retire from 2026-11-24");
  });

  it("is silent for Haiku 4.5, whose earliest date passed without a notice", () => {
    expect(note("anthropic", "claude-haiku-4-5-20251001")).toBeUndefined();
  });

  it("says retired once the date has passed", () => {
    expect(note("anthropic", "claude-sonnet-4-5", "2026-12-01")?.severity).toBe(
      "retired",
    );
    expect(note("anthropic", "claude-opus-4-1-20250805")?.severity).toBe(
      "retired",
    );
  });

  it("is silent outside the 60-day window and for current models", () => {
    expect(note("anthropic", "claude-opus-4-5", "2026-09-01")).toBeUndefined();
    expect(note("anthropic", "claude-sonnet-5-5")).toBeUndefined();
    expect(note("anthropic", "claude-opus-4-8")).toBeUndefined();
  });

  it("never applies to Bedrock or Vertex, which keep their own schedules", () => {
    expect(
      note("bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"),
    ).toBeUndefined();
    expect(note("vertexai", "claude-sonnet-4-5@20250929")).toBeUndefined();
  });

  it("prefers the date the user's own key returned", () => {
    const n = note("anthropic", "claude-sonnet-4-5-20250929", NOW, {
      lifecycle: "deprecated",
      deprecatedAt: "2026-09-30T00:00:00Z",
      retiresAt: "2026-12-15T00:00:00Z",
    });
    expect(n).toMatchObject({ from: "live", retiresAt: "2026-12-15" });
    expect(n?.sourceUrl).toBeUndefined();
  });

  it("warns from a live deprecation for a model the table does not know", () => {
    const n = note("anthropic", "claude-future-1", NOW, {
      lifecycle: "deprecated",
      retiresAt: "2026-12-01",
    });
    expect(n?.severity).toBe("retiring");
    expect(n?.replacement).toBeUndefined();
  });

  it("changes its key when the dates or severity change", () => {
    const a = note("anthropic", "claude-sonnet-4-5");
    const b = note("anthropic", "claude-sonnet-4-5", "2026-12-01");
    expect(a?.key).not.toBe(b?.key);
  });
});

describe("retirementNotice for OpenAI", () => {
  it("speaks only from OpenAI's own shutdown_date", () => {
    expect(
      retirementNotice({
        provider: "openai",
        model: "gpt-4.1",
        now: "2026-11-13",
      }),
    ).toBeUndefined();
    expect(
      retirementNotice({
        provider: "openai",
        model: "gpt-4.1",
        now: "2026-11-13",
        live: { lifecycle: "deprecated", retiresAt: "2027-02-14" },
      }),
    ).toMatchObject({
      from: "live",
      severity: "retiring",
      retiresAt: "2027-02-14",
      message: expect.stringContaining("retires on 2027-02-14"),
    });
  });

  it("other providers still get nothing", () => {
    expect(
      retirementNotice({
        provider: "mistral",
        model: "m",
        now: "2026-11-13",
        live: { lifecycle: "deprecated", retiresAt: "2027-02-14" },
      }),
    ).toBeUndefined();
  });
});

describe("liveFromFetched (a model list the person fetched)", () => {
  it("keeps the deprecated flag and the date from an Anthropic list", () => {
    expect(
      liveFromFetched("anthropic", [
        {
          name: "Claude Sonnet 4.5",
          modelId: "claude-sonnet-4-5-20250929",
          deprecated: true,
          retiresAt: "2026-11-30T00:00:00Z",
        },
        {
          name: "Claude Sonnet 5.5",
          modelId: "claude-sonnet-5-5",
          deprecated: false,
        },
        // An older API version: no lifecycle field, nothing to record
        { name: "Claude Haiku 5.5", modelId: "claude-haiku-5-5" },
      ]),
    ).toEqual([
      {
        model: "claude-sonnet-4-5-20250929",
        live: { lifecycle: "deprecated", retiresAt: "2026-11-30T00:00:00Z" },
      },
      { model: "claude-sonnet-5-5", live: { lifecycle: "active" } },
    ]);
  });

  it("records nothing for providers whose notices do not read live facts", () => {
    expect(
      liveFromFetched("bedrock", [
        { name: "x", modelId: "anthropic.claude-sonnet-4-5", deprecated: true },
      ]),
    ).toEqual([]);
  });

  it("a fetched past date reads as retired, a future one as retiring", () => {
    const [past] = liveFromFetched("anthropic", [
      {
        name: "a",
        modelId: "claude-a",
        deprecated: true,
        retiresAt: "2026-11-01",
      },
    ]);
    expect(
      note("anthropic", past.model, "2026-11-14", past.live)?.severity,
    ).toBe("retired");
    const [future] = liveFromFetched("anthropic", [
      {
        name: "b",
        modelId: "claude-b",
        deprecated: true,
        retiresAt: "2027-01-01",
      },
    ]);
    expect(
      note("anthropic", future.model, "2026-11-14", future.live),
    ).toMatchObject({ severity: "retiring", from: "live", daysLeft: 48 });
  });
});

describe("llm-info recommendations", () => {
  it("never recommend a model marked deprecated or retired", () => {
    const ids = getAllRecommendedFor("chat")
      .filter((m) => m.provider === "anthropic")
      .map((m) => m.model);
    expect(ids).not.toContain("claude-sonnet-4-5-20250929");
    expect(ids).not.toContain("claude-opus-4-1-20250805");
    expect(ids).toContain("claude-sonnet-5-5");
  });
});
