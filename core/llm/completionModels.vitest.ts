import { describe, expect, it } from "vitest";

import { isRecommendedForAutocomplete } from "./completionModels";

describe("isRecommendedForAutocomplete", () => {
  it("follows the catalogue's recommendedFor", () => {
    expect(isRecommendedForAutocomplete("codestral-latest", "mistral")).toBe(
      true,
    );
    expect(isRecommendedForAutocomplete("claude-sonnet-4-5", "anthropic")).toBe(
      false,
    );
  });

  it("is false for a model the catalogue does not know", () => {
    expect(isRecommendedForAutocomplete("some-local-model:8b")).toBe(false);
  });
});
