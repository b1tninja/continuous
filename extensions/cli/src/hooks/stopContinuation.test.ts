/**
 * D4: a Stop hook that blocks sends the assistant back to work, at most three
 * times in a row, and the count starts again with the person's next message.
 * The hooks really run (`node <script>`); the turns are stand-ins, so nothing
 * calls a model.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { runHooks } from "./hookRunner.js";
import {
  MAX_STOP_CONTINUATIONS,
  runTurnWithStopHooks,
  stopHookFeedback,
} from "./lifecycleHooks.js";
import type { HookInput, HooksConfig } from "./types.js";

let dir: string;
let liveConfig: HooksConfig = {};

vi.mock("../services/index.js", () => ({
  services: {
    toolPermissions: undefined,
    hooks: {
      isReady: () => true,
      fireEvent: (input: HookInput) => runHooks(liveConfig, input, dir),
    },
  },
}));
vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "sess-1" }),
}));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-stop-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => path.join(dir, "stop.log");

/**
 * A Stop hook that records `stop_hook_active` for each call and blocks the
 * first `blocks` calls since the log was cleared, the way given: exit 2 with
 * a reason on stderr, or `decision: "block"` JSON.
 */
function stopHook(
  blocks: number,
  how: "exit2" | "json" = "exit2",
): HooksConfig {
  const file = JSON.stringify(log());
  const block =
    how === "exit2"
      ? 'process.stderr.write("tests are failing, fix them"); process.exit(2);'
      : 'process.stdout.write(JSON.stringify({ decision: "block", reason: "tests are failing, fix them" }));';
  const body = [
    'const fs = require("fs");',
    'let s = "";',
    'process.stdin.on("data", (d) => (s += d)).on("end", () => {',
    `  const seen = fs.existsSync(${file}) ? fs.readFileSync(${file}, "utf-8").split("\\n").filter(Boolean) : [];`,
    `  fs.appendFileSync(${file}, String(JSON.parse(s).stop_hook_active) + "\\n");`,
    `  if (seen.length < ${blocks}) { ${block} }`,
    "});",
  ].join("\n");
  const script = path.join(dir, `stop-${blocks}-${how}.cjs`);
  fs.writeFileSync(script, body);
  return {
    Stop: [{ hooks: [{ type: "command", command: `node "${script}"` }] }],
  };
}

const calls = () =>
  fs.existsSync(log())
    ? fs.readFileSync(log(), "utf-8").split("\n").filter(Boolean)
    : [];

/** One message from the person, with stand-in turns. */
async function personMessage() {
  const added: string[] = [];
  const notices: string[] = [];
  let turns = 0;
  const last = await runTurnWithStopHooks({
    runTurn: async () => `reply ${++turns}`,
    addUserMessage: (text) => added.push(text),
    notice: (text) => notices.push(text),
  });
  return { added, notices, turns, last };
}

describe("Stop hook continuations (D4)", () => {
  beforeEach(() => {
    fs.rmSync(log(), { force: true });
  });

  it("the cap is three", () => {
    expect(MAX_STOP_CONTINUATIONS).toBe(3);
  });

  it("a hook blocking four times continues three times, then the turn ends with a notice", async () => {
    liveConfig = stopHook(4);
    const { added, notices, turns, last } = await personMessage();
    expect(turns).toBe(4);
    expect(last).toBe("reply 4");
    expect(added).toEqual([
      stopHookFeedback("tests are failing, fix them"),
      stopHookFeedback("tests are failing, fix them"),
      stopHookFeedback("tests are failing, fix them"),
    ]);
    expect(added[0]).toBe("Stop hook feedback:\ntests are failing, fix them");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("3 continuations");
    expect(notices[0]).toContain("tests are failing, fix them");
    // stop_hook_active is false on the first Stop and true on continuations
    expect(calls()).toEqual(["false", "true", "true", "true"]);
  });

  it('decision: "block" continues the same way', async () => {
    liveConfig = stopHook(1, "json");
    const { added, notices, turns } = await personMessage();
    expect(turns).toBe(2);
    expect(added).toEqual([stopHookFeedback("tests are failing, fix them")]);
    expect(notices).toEqual([]);
  });

  it("a hook that stops blocking ends the turn without a notice", async () => {
    liveConfig = stopHook(2);
    const { added, notices, turns } = await personMessage();
    expect(turns).toBe(3);
    expect(added).toHaveLength(2);
    expect(notices).toEqual([]);
    expect(calls()).toEqual(["false", "true", "true"]);
  });

  it("the count starts again with the person's next message", async () => {
    liveConfig = stopHook(Number.MAX_SAFE_INTEGER);
    const first = await personMessage();
    const second = await personMessage();
    expect(first.turns).toBe(4);
    expect(second.turns).toBe(4);
    expect(second.notices).toHaveLength(1);
    expect(calls()).toEqual([
      "false",
      "true",
      "true",
      "true",
      "false",
      "true",
      "true",
      "true",
    ]);
  });

  it("a hook that exits 0 does not continue", async () => {
    liveConfig = stopHook(0);
    const { turns, added, notices } = await personMessage();
    expect(turns).toBe(1);
    expect(added).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("no Stop hook runs after a cancelled turn", async () => {
    liveConfig = stopHook(4);
    let turns = 0;
    await runTurnWithStopHooks({
      runTurn: async () => `reply ${++turns}`,
      addUserMessage: () => {},
      notice: () => {},
      cancelled: () => true,
    });
    expect(turns).toBe(1);
    expect(calls()).toEqual([]);
  });

  it("ends the turn when the feedback cannot be added", async () => {
    liveConfig = stopHook(4);
    let turns = 0;
    await runTurnWithStopHooks({
      runTurn: async () => `reply ${++turns}`,
      addUserMessage: () => false,
      notice: () => {},
    });
    expect(turns).toBe(1);
  });
});
