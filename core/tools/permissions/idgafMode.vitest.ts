import { describe, expect, test } from "vitest";

import { approvalLoosening } from "./approval";
import { decideToolCall, type DecideInput } from "./decide";
import { parsePermissions } from "./names";
import { DEFAULT_POLICY_LEVELS } from "./policy";

const denyRm = parsePermissions({ deny: ["runTerminalCommand(rm *)"] });
const askGit = parsePermissions({ ask: ["runTerminalCommand(git *)"] });

function looseningFor(level: "idgaf" | "permissive") {
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

describe.each([
  ["a deny rule", { rules: denyRm }],
  ["an ask rule", { rules: askGit, parsedArgs: { command: "git push" } }],
  ["the safety floor", { evaluated: "disabled" as const }],
  ["a protected path", { protectedHit }],
])("with %s", (_name, over) => {
  test("IDGAF allows the call", () => {
    expect(
      decideToolCall(call({ ...over, loosening: looseningFor("idgaf") })),
    ).toMatchObject({
      policy: "allowedWithoutPermission",
      source: "idgaf",
    });
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

test("a tool switched off stays off, even in IDGAF", () => {
  expect(
    decideToolCall(
      call({
        base: "disabled",
        evaluated: "disabled",
        loosening: looseningFor("idgaf"),
      }),
    ).policy,
  ).toBe("disabled");
});
