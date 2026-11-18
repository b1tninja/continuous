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

  it("uses the short sentence when a policy denial has no reason", () => {
    expect(policyDenialContent(undefined)).toBe(
      "Command blocked by security policy",
    );
  });
});
