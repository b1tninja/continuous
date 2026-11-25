import { describe, expect, it } from "vitest";
import { isModelAccessError } from "./modelAccess";

describe("an error that says the account may not use the model", () => {
  const refused: [string, string][] = [
    [
      "Bedrock without a grant",
      "Error streaming edit diffs: Amazon Bedrock refused us.anthropic.claude-fable-5-1: this AWS account has not been given access to that model.",
    ],
    [
      "Bedrock, model not offered",
      "anthropic.claude-fable-5-1 is not available for this account.",
    ],
    ["an access denied exception", "AccessDeniedException: not allowed"],
    ["a 401 from the provider", "Request failed with status code 401"],
    ["a bad key", "Incorrect API key provided"],
    ["a 403", "HTTP 403 Forbidden"],
  ];
  for (const [name, message] of refused) {
    it(`${name} is one`, () => {
      expect(isModelAccessError(new Error(message))).toBe(true);
    });
  }

  const other: [string, string][] = [
    ["a timeout", "Error streaming edit diffs: request timed out"],
    ["a rate limit", "429 Too Many Requests: rate limit exceeded"],
    ["the file changing", "The file changed since it was read"],
    [
      "a connection that was refused by the server being down",
      "connect ECONNREFUSED 127.0.0.1:8081",
    ],
  ];
  for (const [name, message] of other) {
    it(`${name} is not one, so the edit fails as it did`, () => {
      expect(isModelAccessError(new Error(message))).toBe(false);
    });
  }

  it("is false for something that is not an error", () => {
    expect(isModelAccessError(undefined)).toBe(false);
    expect(isModelAccessError({})).toBe(false);
  });
});
