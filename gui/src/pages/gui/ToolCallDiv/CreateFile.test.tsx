import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateFile, createFileText } from "./CreateFile";

vi.mock("../../../components/StyledMarkdownPreview", () => ({
  default: ({ source }: { source: string }) => (
    <pre data-testid="preview">{source}</pre>
  ),
}));

// Some models send the contents of a JSON file as a JSON value (upstream 13362)
describe("CreateFile", () => {
  it("shows contents sent as a JSON value as indented text", () => {
    render(
      <CreateFile
        relativeFilepath="config.json"
        fileContents={{ name: "x", list: [1] }}
        historyIndex={0}
      />,
    );
    const shown = screen.getByTestId("preview").textContent ?? "";
    expect(shown).toContain('{\n  "name": "x",\n  "list": [\n    1\n  ]\n}');
    expect(shown).not.toContain("[object Object]");
  });

  it("shows text as it was sent", () => {
    render(
      <CreateFile
        relativeFilepath="a.txt"
        fileContents="one"
        historyIndex={0}
      />,
    );
    expect(screen.getByTestId("preview").textContent).toContain("\none\n");
  });

  it("has nothing to show for missing contents", () => {
    expect(createFileText(undefined)).toBe("");
    expect(createFileText(null)).toBe("");
  });
});
