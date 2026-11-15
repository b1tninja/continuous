import fs from "fs";
import os from "os";
import path from "path";

import type { Session } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CANARY = "sk-ant-api03-CANARYCANARYCANARYCANARY0123456789";

const stored: Session = {
  sessionId: "abcdef12-0000",
  title: "A run",
  workspaceDirectory: "/w",
  history: [
    {
      message: { role: "user", content: `use ${CANARY}` },
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

const { exportCommand, exportCurrentSession } =
  await import("./exportCommand.js");

describe("continuous export", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  const io = {
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-exportcmd-"));
    out = [];
    err = [];
    return () => fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints a masked Markdown transcript of a session found by id prefix", () => {
    expect(exportCommand("abcdef", {}, io)).toBe(0);
    const text = out.join("");
    expect(text.startsWith("# A run\n\n2026-11-01\n")).toBe(true);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("abcdef12-0000");
  });

  it("finds the newest session with last, and writes HTML to --out", () => {
    const file = path.join(dir, "t.html");
    expect(exportCommand("last", { out: file }, io)).toBe(0);
    const html = fs.readFileSync(file, "utf-8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain(CANARY);
  });

  it("refuses to replace --out without --force", () => {
    const file = path.join(dir, "t.md");
    fs.writeFileSync(file, "keep");
    expect(exportCommand("last", { out: file }, io)).toBe(1);
    expect(err.join("")).toMatch(/--force/);
    expect(fs.readFileSync(file, "utf-8")).toBe("keep");
    expect(exportCommand("last", { out: file, force: true }, io)).toBe(0);
  });

  it("exits 1 on an unknown session or format", () => {
    expect(exportCommand("nope", {}, io)).toBe(1);
    expect(exportCommand("last", { format: "pdf" }, io)).toBe(1);
  });

  it("/export writes the current session to the path given", () => {
    const file = path.join(dir, "here.md");
    const result = exportCurrentSession([file]);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(CANARY);
    expect(exportCurrentSession([file]).ok).toBe(false);
    expect(exportCurrentSession([file, "--force"]).ok).toBe(true);
  });
});
