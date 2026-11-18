import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildCliScenario,
  enterScenarioDir,
  normalize,
  SCENARIOS,
} from "./segmentScenarios.js";

vi.mock("../services/ServiceContainer.js", () => ({
  serviceContainer: {
    get: vi.fn(async () => ({ config: { rules: [] } })),
    getSync: vi.fn(() => ({ value: undefined })),
    set: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

/**
 * Byte-identity guard for the prompt-segment work: each CLI scenario's request
 * (tools and messages as `buildChatRequestBody` returns them, machine facts
 * normalised) hashes to the value recorded on main before the manifest code
 * was added. Update deliberately with `WRITE_GOLDEN=1`.
 */
const GOLDEN_FILE = join(__dirname, "requestGolden.json");

describe("CLI requests are byte-identical to the recorded goldens", () => {
  const actual: Record<string, string> = {};
  beforeAll(async () => {
    enterScenarioDir();
    for (const [name, spec] of Object.entries(SCENARIOS)) {
      const r = await buildCliScenario(spec);
      actual[name] = createHash("sha256")
        .update(
          normalize(JSON.stringify({ tools: r.tools, messages: r.messages })),
        )
        .digest("hex");
    }
    if (process.env.WRITE_GOLDEN) {
      writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + "\n");
    }
  });
  for (const name of Object.keys(SCENARIOS)) {
    it(name, () => {
      const golden = existsSync(GOLDEN_FILE)
        ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8"))
        : {};
      expect(actual[name]).toBe(golden[name]);
    });
  }
});
