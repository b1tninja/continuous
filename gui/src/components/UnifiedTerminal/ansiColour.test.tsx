import { describe, expect, test, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { UnifiedTerminalCommand } from "./UnifiedTerminal";

// The copy control is an icon with no label: what matters is the text it is given
const copied = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("../StyledMarkdownPreview/StepContainerPreToolbar/CopyButton", () => ({
  CopyButton: ({ text }: { text: string }) => {
    copied.texts.push(text);
    return null;
  },
}));

const ESC = "\u001b";
// Fake values only: shaped like secrets, belonging to nobody
const FAKE = "fake-token-value-for-tests";

/**
 * Colour in a command's output. `output` is the plain text (what is copied and
 * what the model read); `displayOutput` is the same with its escape sequences,
 * for drawing. Masking of secrets must hold for what is drawn too.
 */
describe("UnifiedTerminalCommand: colour", () => {
  test("draws the colours from displayOutput", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand
        command="npm test"
        output={"FAIL src/a.test.ts\n"}
        displayOutput={`${ESC}[31mFAIL${ESC}[0m src/a.test.ts\n`}
        status="completed"
      />,
    );
    expect(container.textContent).toContain("FAIL src/a.test.ts");
    // no raw escape character is shown as text
    expect(container.textContent).not.toContain(ESC);
    // the colour is drawn: a styled element holds the word
    const styled = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "FAIL",
    );
    expect(styled).toBeTruthy();
    expect(
      styled!.getAttribute("class") || styled!.getAttribute("style") || "",
    ).not.toBe("");
  });

  test("with no displayOutput it draws the plain output, as before", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand
        command="echo hi"
        output="hi there\n"
        status="completed"
      />,
    );
    expect(container.textContent).toContain("hi there");
  });

  test("a secret in the output is hidden in the coloured text too", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand
        command="env"
        output={`HOME=/home/x\nAPI_KEY=${FAKE}\n`}
        displayOutput={`HOME=/home/x\n${ESC}[33mAPI_KEY${ESC}[0m=${FAKE}\n`}
        status="completed"
      />,
    );
    expect(container.innerHTML).not.toContain(FAKE);
    expect(container.textContent).toContain("API_KEY");
  });

  test("a credential with a colour code inside it is not shown", async () => {
    // Recognised by its shape only (no variable name to key on), and split by
    // an escape sequence, so a mask that read the coloured text would miss it.
    // The plain text is masked instead.
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const split = `${token.slice(0, 12)}${ESC}[0m${token.slice(12)}`;
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand
        command="curl"
        output={`using ${token} for the request\n`}
        displayOutput={`using ${split} for the request\n`}
        status="completed"
      />,
    );
    expect(container.innerHTML).not.toContain(token);
    expect(container.innerHTML).not.toContain(token.slice(0, 12));
    expect(container.innerHTML).not.toContain(token.slice(12));
    expect(container.textContent).toContain("for the request");
  });

  test("copy gives the plain text, with no escape sequences", async () => {
    copied.texts.length = 0;
    await renderWithProviders(
      <UnifiedTerminalCommand
        command="npm test"
        output={"FAIL src/a.test.ts\n"}
        displayOutput={`${ESC}[31mFAIL${ESC}[0m src/a.test.ts\n`}
        status="completed"
      />,
    );
    // the button was rendered, and was given the command and the plain output
    expect(copied.texts.length).toBeGreaterThan(0);
    for (const text of copied.texts) {
      expect(text).not.toContain(ESC);
      expect(text).toContain("npm test");
      expect(text).toContain("FAIL src/a.test.ts");
    }
  });

  test("an empty displayOutput draws nothing, not the plain output twice", async () => {
    const { container } = await renderWithProviders(
      <UnifiedTerminalCommand
        command="true"
        output="only once\n"
        displayOutput=""
        status="completed"
      />,
    );
    const count = (container.textContent?.match(/only once/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(1);
  });
});
