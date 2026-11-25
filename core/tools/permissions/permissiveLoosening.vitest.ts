import { describe, expect, test } from "vitest";

import { approvalLoosening } from "./approval";
import { decideToolCall, type DecideInput } from "./decide";
import { parsePermissions } from "./names";
import { DEFAULT_POLICY_LEVELS } from "./policy";

const denyRm = parsePermissions({ deny: ["runTerminalCommand(rm *)"] });
const askGit = parsePermissions({ ask: ["runTerminalCommand(git *)"] });

function looseningFor(level: "permissive" | "automatic" | "cautious") {
  return approvalLoosening({
    approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools: level } },
    toolName: "run_terminal_command",
    parsedArgs: {},
  } as never);
}

const call = (over: Partial<DecideInput>): DecideInput => ({
  toolName: "run_terminal_command",
  parsedArgs: { command: "rm -rf build" },
  base: "allowedWithPermission",
  evaluated: "allowedWithPermission",
  rules: [],
  ...over,
});

const protectedHit = { kind: "path", path: ".env" } as never;

/**
 * Permissive acts only on a call that would otherwise ask. A rule or a block
 * that is in force stands, at every level: no level reads another level's
 * name, and what a switched-off check would have said never reaches here.
 */
describe.each([
  ["a deny rule", { rules: denyRm }],
  ["an ask rule", { rules: askGit, parsedArgs: { command: "git push" } }],
])("with %s", (_name, over) => {
  test("Permissive leaves it as it was", () => {
    const decided = decideToolCall(
      call({ ...over, loosening: looseningFor("permissive") }),
    );
    expect(decided.source).not.toBe("permissive");
    expect(decided.policy).not.toBe("allowedWithoutPermission");
  });

  test("so does a level with no loosening at all", () => {
    const decided = decideToolCall(call({ ...over, loosening: undefined }));
    expect(decided.policy).not.toBe("allowedWithoutPermission");
  });
});

// A block from the safety floor or a protected path reaches the decision only
// when its safety check is on (the evaluator skips the ones that are off), so
// it stands. With the IDGAF preset no check is on, so no block arrives.
describe.each([
  ["the safety floor", { evaluated: "disabled" as const }, "safety-floor"],
  ["a protected path", { protectedHit }, "protected-path"],
])("with %s from a check that is on", (_name, over, source) => {
  test("it stands whatever the level", () => {
    for (const level of ["cautious", "permissive", "automatic"] as const) {
      expect(
        decideToolCall(call({ ...over, loosening: looseningFor(level) })),
        level,
      ).toMatchObject({ source });
    }
  });

  test("Permissive leaves it as it was", () => {
    const decided = decideToolCall(
      call({ ...over, loosening: looseningFor("permissive") }),
    );
    expect(decided.source).not.toBe("permissive");
    expect(decided.policy).not.toBe("allowedWithoutPermission");
  });
});

test("Permissive allows a call nothing has settled", () => {
  expect(
    decideToolCall(call({ loosening: looseningFor("permissive") })),
  ).toMatchObject({
    policy: "allowedWithoutPermission",
    source: "permissive",
  });
});

test("a tool switched off stays off at every level", () => {
  for (const level of ["cautious", "permissive", "automatic"] as const) {
    expect(
      decideToolCall(
        call({
          base: "disabled",
          evaluated: "disabled",
          loosening: looseningFor(level),
        }),
      ).policy,
      level,
    ).toBe("disabled");
  }
});
