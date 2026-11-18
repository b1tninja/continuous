import { describe, expect, it } from "vitest";

import {
  assistant,
  turnCases as cases,
  user,
  validHistories,
} from "./normalizeTurns.fixtures.js";
import { normalizeTurns } from "./normalizeTurns.js";

/** Freezes a history all the way down, so a test fails on any write to it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("normalizeTurns: repairs", () => {
  it.each(cases)("$name", (c) => {
    const input = deepFreeze(structuredClone(c.input));
    const { messages, repairs } = normalizeTurns(input, {
      requiresAlternation: c.requiresAlternation,
    });
    expect(messages).toEqual(c.expected);
    expect(repairs).toEqual(c.repairs);
    expect(input).toEqual(c.input); // never written to
    if (c.repairs.length === 0) {
      expect(messages).toBe(input);
    } else {
      expect(messages).not.toBe(input);
    }
  });

  it("repairs are idempotent: a repaired history needs nothing more", () => {
    for (const c of cases) {
      const options = { requiresAlternation: c.requiresAlternation };
      const once = normalizeTurns(c.input, options).messages;
      const twice = normalizeTurns(once, options);
      expect(twice.repairs, c.name).toEqual([]);
      expect(twice.messages).toBe(once);
    }
  });

  it("keeps a message object it did not repair", () => {
    const keep = user("q");
    const { messages } = normalizeTurns([keep, assistant(""), user("x")]);
    expect(messages[0]).toBe(keep);
  });
});

describe("normalizeTurns: valid histories are returned as they came", () => {
  it.each(Object.entries(validHistories))("%s", (_name, history) => {
    const before = JSON.stringify(history);
    for (const requiresAlternation of [false, true]) {
      const { messages, repairs } = normalizeTurns(history, {
        requiresAlternation,
      });
      expect(repairs).toEqual([]);
      expect(messages).toBe(history);
      expect(JSON.stringify(messages)).toBe(before);
    }
  });
});
