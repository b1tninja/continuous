import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSafeMode } from "./safeMode.js";

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

vi.mock("./hubLoader.js", () => ({
  processRule: vi
    .fn()
    .mockImplementation((spec: string) => Promise.resolve(spec)),
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-safe-sys-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "AGENT-FILE-MARKER");
  fs.mkdirSync(path.join(dir, ".continuous", "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".continuous", "rules", "r.md"),
    "RULE-FILE-MARKER",
  );
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
  setSafeMode(false);
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the system message in safe mode", () => {
  it("reads the agent file and the rules folders without safe mode", async () => {
    expect(loadMarkdownRulesWithMetadata().map((r) => r.rule)).toContain(
      "RULE-FILE-MARKER",
    );
    expect(await constructSystemMessage("normal")).toContain(
      "AGENT-FILE-MARKER",
    );
  });

  it("reads neither in safe mode, and keeps --rule text", async () => {
    setSafeMode(true);
    expect(loadMarkdownRulesWithMetadata()).toEqual([]);
    const message = await constructSystemMessage("normal", [
      "FLAG-RULE-MARKER",
    ]);
    expect(message).not.toContain("AGENT-FILE-MARKER");
    expect(message).not.toContain("RULE-FILE-MARKER");
    expect(message).toContain("FLAG-RULE-MARKER");
  });
});
