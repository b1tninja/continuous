import { describe, expect, it } from "vitest";

import { policyDenialContent } from "./streamChatResponse.helpers.js";

const HINT =
  "The command was not run: Windows PowerShell 5.1 cannot parse it. && is not a statement separator in Windows PowerShell 5.1: the whole command fails to parse and nothing runs. Instead: echo A; if ($?) { echo B } Fix it and call again.";

describe("policyDenialContent", () => {
  it("passes a shell-hint parse failure through without the security-policy wrapper", () => {
    const text = policyDenialContent(HINT, "shell-hint");
    expect(text).toBe(HINT);
    expect(text).not.toMatch(/security policy/i);
    expect(text).not.toMatch(/Do not retry/);
    expect(text).toContain("Instead:");
    expect(text).toContain("Fix it and call again");
  });

  it("recognises the parse-failure sentence even without a source", () => {
    expect(policyDenialContent(HINT)).toBe(HINT);
  });

  it("keeps the security-policy wrapper for other refusals", () => {
    const text = policyDenialContent("Blocked by your rule rm*.");
    expect(text).toMatch(/^Command blocked by security policy: /);
    expect(text).toContain("Blocked by your rule rm*.");
    expect(text).toMatch(/Do not retry/);
  });

  it("says the tool is excluded, and what to do next, when a policy denial has no reason", () => {
    expect(policyDenialContent(undefined, undefined, "Write")).toBe(
      "Write is excluded for this run, so it was not run. Do not retry this call or reach the same result another way. Do what else the request needs, then say what you could not do and why.",
    );
  });

  it("ends a refusal with a reason in core's tail, word for word", () => {
    expect(policyDenialContent("Blocked by your rule rm*.")).toBe(
      "Command blocked by security policy: Blocked by your rule rm*. Do not retry this call or reach the same result another way. Do what else the request needs, then say what you could not do and why.",
    );
  });
});
