import fs from "fs";
import os from "os";
import path from "path";

import type { Session } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* V13: an export is scrubbed by default and says how many values were
   masked; --raw keeps the text and warns. */

const CANARY = "sk-ant-api03-CANARYCANARYCANARYCANARY0123456789";
const GITHUB = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5".slice(0, 36);

const stored: Session = {
  sessionId: "abcdef12-0000",
  title: "A run",
  workspaceDirectory: "/w",
  history: [
    {
      message: { role: "user", content: `use ${CANARY} and ${GITHUB}` },
      contextItems: [],
    },
    { message: { role: "assistant", content: "Done." }, contextItems: [] },
  ],
} as Session;

vi.mock("core/util/history.js", () => ({
  default: {
    list: () => [
      {
        sessionId: "abcdef12-0000",
        title: "A run",
        dateCreated: "2026-11-01T10:00:00Z",
        workspaceDirectory: "/w",
      },
    ],
  },
}));

vi.mock("../session.js", () => ({
  loadSessionById: (id: string) => (id === stored.sessionId ? stored : null),
  getCurrentSession: () => stored,
}));

const {
  exportCommand,
  exportCurrentSession,
  maskedCountLine,
  RAW_EXPORT_WARNING,
  sessionExportPayload,
} = await import("./exportCommand.js");

describe("export masking report and --raw (V13)", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  const io = {
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-exportmask-"));
    out = [];
    err = [];
    return () => fs.rmSync(dir, { recursive: true, force: true });
  });

  it("continuous export: the transcript on stdout, the count on stderr", () => {
    expect(exportCommand("abcdef", {}, io)).toBe(0);
    expect(out.join("")).not.toContain(CANARY);
    expect(out.join("")).not.toContain("values masked");
    expect(err.join("")).toContain("2 values masked");
  });

  it("continuous export --out: the count with the path", () => {
    const file = path.join(dir, "t.md");
    expect(exportCommand("last", { out: file }, io)).toBe(0);
    expect(err.join("")).toMatch(/Exported to .*t\.md\. 2 values masked/);
  });

  it("continuous export --raw keeps the text and warns", () => {
    expect(exportCommand("abcdef", { raw: true }, io)).toBe(0);
    expect(out.join("")).toContain(CANARY);
    expect(out.join("")).toContain(GITHUB);
    expect(err.join("")).toContain(RAW_EXPORT_WARNING);
    expect(err.join("")).not.toMatch(/\d+ values? masked/);
  });

  it("/export reports the count", () => {
    const file = path.join(dir, "s.md");
    const result = exportCurrentSession([file]);
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.message).toContain("2 values masked");
    expect(fs.readFileSync(file, "utf-8")).not.toContain(CANARY);
  });

  it("/export --raw writes the text as it is, with the warning", () => {
    const file = path.join(dir, "raw.md");
    const result = exportCurrentSession([file, "--raw"]);
    expect(result).toMatchObject({ ok: true, warning: true });
    expect(result.message).toContain(RAW_EXPORT_WARNING);
    expect(fs.readFileSync(file, "utf-8")).toContain(CANARY);
    // the flag is not taken as part of the path
    expect(fs.existsSync(path.join(dir, "raw.md --raw"))).toBe(false);
  });

  it("counts nothing in a session without secrets", () => {
    const file = path.join(dir, "clean.md");
    const clean = { ...stored, history: [stored.history[1]] };
    vi.spyOn(stored, "history", "get").mockReturnValue(clean.history);
    expect(exportCurrentSession([file]).message).toContain("0 values masked");
  });

  it("says value, not values, for one", () => {
    expect(maskedCountLine(1)).toMatch(/^1 value masked\./);
  });
});

describe("/export --json payload (V13)", () => {
  const session = (): Session =>
    ({
      sessionId: "s1",
      title: "t",
      workspaceDirectory: "/w",
      history: [
        {
          message: { role: "user", content: `key ${GITHUB}` },
          contextItems: [],
        },
      ],
    }) as Session;

  it("scrubs the session with the at-rest rules and counts", () => {
    const { payload, masked } = sessionExportPayload(session(), {
      now: new Date("2026-11-15T00:00:00Z"),
    });
    expect(masked).toBe(1);
    expect(payload).toMatchObject({
      version: 1,
      exportedAt: "2026-11-15T00:00:00.000Z",
    });
    expect(JSON.stringify(payload)).not.toContain(GITHUB);
    expect(JSON.stringify(payload)).toContain("[REDACTED:");
    // still a session /import accepts
    expect(payload.session.sessionId).toBe("s1");
    expect(Array.isArray(payload.session.history)).toBe(true);
  });

  it("--raw keeps the session as it is", () => {
    const s = session();
    const { payload, masked } = sessionExportPayload(s, { raw: true });
    expect(masked).toBe(0);
    expect(payload.session).toBe(s);
    expect(JSON.stringify(payload)).toContain(GITHUB);
  });
});
