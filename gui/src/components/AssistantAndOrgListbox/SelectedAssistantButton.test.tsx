import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { Listbox } from "../ui";
import { SelectedAssistantButton } from "./SelectedAssistantButton";

describe("SelectedAssistantButton", () => {
  it("is named by the full config title, with an icon for narrow bars", async () => {
    await renderWithProviders(
      <Listbox value="" onChange={() => {}}>
        <SelectedAssistantButton
          variant="lump"
          selectedProfile={{ id: "a", title: "Main Config" } as any}
        />
      </Listbox>,
    );
    const button = screen.getByTestId("assistant-select-button");
    expect(button.getAttribute("aria-label")).toBe("Config: Main Config");
    expect(screen.getByTestId("assistant-select-icon")).toBeDefined();
    expect(button.textContent).toBe("Main Config");
  });
});
