import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  fakeAnthropicKey,
  hiddenFixture,
  hiddenFixtureLoaded,
  longFixture,
} from "core/config/markdown/instructionFileFixture.js";
import type { InstructionFileNotice } from "core/config/markdown/instructionFiles.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readInstructionFile } from "./instructionFiles.js";

// The real implementation, not the shared mock
vi.unmock("./systemMessage.js");
const { constructSystemMessage, loadMarkdownRulesWithMetadata } =
  await import("./systemMessage.js");

vi.mock("./services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn().mockResolvedValue({ config: { rules: [] } }),
    set: vi.fn(),
  },
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-instr-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function collect(file: string) {
  const notices: InstructionFileNotice[] = [];
  const text = readInstructionFile(file, (n) => notices.push(n));
  return { text, notices };
}

describe("instruction files in the CLI (X20, X29, cap)", () => {
  it("loads the shared fixture as the IDE does, and warns", () => {
    const key = fakeAnthropicKey();
    const file = path.join(dir, "AGENTS.md");
    fs.writeFileSync(file, hiddenFixture(key));
    const { text, notices } = collect(file);
    expect(text).toBe(hiddenFixtureLoaded(key));
    expect(notices.map((n) => [n.kind, n.name])).toEqual([
      ["hidden-characters", "AGENTS.md"],
      ["secret", "AGENTS.md"],
    ]);
    for (const n of notices) expect(n.message).not.toContain(key);
  });

  it("cuts a 40 KiB AGENTS.md with a line naming it", () => {
    const file = path.join(dir, "AGENTS.md");
    fs.writeFileSync(file, longFixture());
    const { text, notices } = collect(file);
    expect(text).toMatch(/\[AGENTS\.md is 40 KiB, over the 32 KiB limit/);
    expect(notices.map((n) => n.kind)).toEqual(["cut"]);
  });

  it("puts the stripped agent file and rule file in the system message", async () => {
    const key = fakeAnthropicKey();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), hiddenFixture(key));
    fs.mkdirSync(path.join(dir, ".continuous", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".continuous", "rules", "r.md"),
      "RULE\u200B-MARKER",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadMarkdownRulesWithMetadata().map((r) => r.rule)).toContain(
      "RULE-MARKER",
    );
    const message = await constructSystemMessage("normal");
    expect(message).toContain(hiddenFixtureLoaded(key).trim());
    expect(message).not.toMatch(/[\u200B\u202E]/u);

    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("r.md: removed 1 hidden"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("AGENTS.md: line 6 holds"))).toBe(
      true,
    );
    expect(warnings.join("\n")).not.toContain(key);
  });
});
