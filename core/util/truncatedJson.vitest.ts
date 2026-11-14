import { describe, expect, test } from "vitest";
import {
  incompleteToolCallResult,
  isTruncatedJson,
  stoppedForLength,
  truncatedToolCallResult,
} from "./truncatedJson.js";

describe("isTruncatedJson", () => {
  test("a complete object is not truncated", () => {
    expect(isTruncatedJson('{"filepath":"a.ts","contents":"x"}')).toBe(false);
    expect(isTruncatedJson('{"a":[1,{"b":"}"}]}')).toBe(false);
    expect(isTruncatedJson("")).toBe(false);
  });

  test("arguments that stop inside a string or an open value are", () => {
    expect(isTruncatedJson('{"filepath":"a.ts","contents":"line 1\\nli')).toBe(
      true,
    );
    expect(isTruncatedJson('{"a":1,')).toBe(true);
    expect(isTruncatedJson('{"a":[1,2')).toBe(true);
  });

  test("braces and escaped quotes inside a string do not count", () => {
    expect(isTruncatedJson('{"c":"{{{ \\" ["}')).toBe(false);
    expect(isTruncatedJson('{"c":"a\\"')).toBe(true);
  });

  test("complete but malformed JSON is left to the lenient parser", () => {
    expect(isTruncatedJson('{"a":1,}')).toBe(false);
  });

  test("the message says nothing was written and how to go on", () => {
    const text = truncatedToolCallResult("create_new_file", 4096);
    expect(text).toContain("output limit of 4096 tokens");
    expect(text).toContain("nothing was written");
    expect(text).toContain("smaller pieces");
    expect(text).toContain("append set to true");
    expect(truncatedToolCallResult("multi_edit", undefined)).not.toContain(
      "append",
    );
  });
});

describe("stoppedForLength", () => {
  test("is true for the output-limit stop reasons", () => {
    expect(stoppedForLength("max_tokens")).toBe(true);
    expect(stoppedForLength("length")).toBe(true);
    expect(stoppedForLength("model_context_window_exceeded")).toBe(true);
    expect(stoppedForLength("MAX_TOKENS")).toBe(true);
  });

  test("is false for a reply that ended for another reason", () => {
    expect(stoppedForLength("tool_use")).toBe(false);
    expect(stoppedForLength("tool_calls")).toBe(false);
    expect(stoppedForLength("end_turn")).toBe(false);
    expect(stoppedForLength("stop")).toBe(false);
  });

  test("is undefined when no reason was reported", () => {
    expect(stoppedForLength(undefined)).toBeUndefined();
    expect(stoppedForLength(null)).toBeUndefined();
    expect(stoppedForLength("")).toBeUndefined();
  });
});

describe("incompleteToolCallResult", () => {
  test("says it was not the output limit and to send the call again", () => {
    const text = incompleteToolCallResult("multi_edit");
    expect(text).toContain("multi_edit");
    expect(text).toContain("nothing was written");
    expect(text).toContain("not the output limit");
    expect(text).toContain("Send the same call again");
    expect(text).not.toContain("smaller pieces");
  });
});
