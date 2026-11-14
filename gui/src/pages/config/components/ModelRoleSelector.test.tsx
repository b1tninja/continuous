import { screen } from "@testing-library/react";
import { LLMConfigurationStatuses } from "core/llm/constants";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import ModelRoleSelector, { noValidModelText } from "./ModelRoleSelector";

const invalid = {
  title: "Broken",
  model: "m",
  provider: "mock",
  configurationStatus: LLMConfigurationStatuses.MISSING_API_KEY,
} as any;

const show = (displayName: string, models: any[]) =>
  renderWithProviders(
    <ModelRoleSelector
      models={models}
      selectedModel={null}
      onSelect={() => {}}
      displayName={displayName}
      description="d"
      setupURL="https://example.invalid/setup"
    />,
  );

describe("ModelRoleSelector: nothing to select", () => {
  it("offers to set up a model when the role has none", async () => {
    await show("Autocomplete", []);
    expect(
      screen.getByRole("button", { name: "Set up Autocomplete model" }),
    ).toBeTruthy();
  });

  it("does not say Chat falls back to the Chat model", async () => {
    await show("Chat", [invalid]);
    expect(screen.getByText("No valid Chat model")).toBeTruthy();
    expect(screen.queryByText(/[Uu]sing Chat/)).toBeNull();
  });

  it("says Edit and Apply use the Chat model, with the whole text as a title", async () => {
    await show("Edit", [invalid]);
    const text = screen.getByText("No valid Edit model, using Chat");
    expect(text.getAttribute("title")).toBe("No valid Edit model, using Chat");
    expect(noValidModelText("Apply")).toBe("No valid Apply model, using Chat");
    expect(noValidModelText("Rerank")).toBe("No valid Rerank model");
  });
});
