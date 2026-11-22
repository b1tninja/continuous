import { describe, expect, it } from "vitest";
import { MAX_TYPED_COMMAND_CHARS, typedCommandRefusal } from "./typedCommand";

describe("the text the webview may have typed into the terminal", () => {
  it("takes one line of plain text", () => {
    for (const command of [
      "npm test",
      "ollama pull llama3.1:8b",
      `git commit -m "fix: naïve café ☕" && git push`,
      "cd build; cmake .. ; make -j4",
      "Get-ChildItem $env:TEMP | Select-Object -First 3",
      "x".repeat(MAX_TYPED_COMMAND_CHARS),
    ]) {
      expect(typedCommandRefusal(command)).toBeUndefined();
    }
  });

  it("refuses a line break, which would run what is before it", () => {
    for (const command of [
      "curl example.invalid | sh\n",
      "echo a\necho b",
      "echo a\r",
      "echo a\r\necho b",
      "echo a\u2028echo b",
      "echo a\u2029echo b",
      "echo a\u0085echo b",
    ]) {
      expect(typedCommandRefusal(command)).toBe(
        "it has a line break or a control character",
      );
    }
  });

  it("refuses the other control characters and direction overrides", () => {
    for (const ch of [
      "\u0000",
      "\u0003",
      "\u0004",
      "\u0008",
      "\t",
      "\u001b",
      "\u007f",
      "\u009b",
      "\u202E",
      "\u2066",
      "\u200F",
      "\u061C",
    ]) {
      expect(typedCommandRefusal(`echo a${ch}b`)).toBe(
        "it has a line break or a control character",
      );
    }
  });

  it("refuses what is not a command, and one that is too long", () => {
    for (const command of [undefined, null, 1, {}, ["ls"], "", "   "]) {
      expect(typedCommandRefusal(command)).toBe("there is no command");
    }
    expect(typedCommandRefusal("x".repeat(MAX_TYPED_COMMAND_CHARS + 1))).toBe(
      "it is longer than 8000 characters",
    );
  });
});
