import { describe, expect, it } from "vitest";

import {
  conversationAsMarkdown,
  markdownToPlainText,
  type CopySource,
} from "./copyAsMarkdown";

const when = new Date(2026, 10, 19, 12, 0, 0);

/** A short conversation: newlines, links, a thinking turn, and reasoning. */
const history: CopySource[] = [
  {
    message: {
      role: "system",
      content: "SYSTEM-PROMPT should not be copied.",
    },
  },
  {
    message: {
      role: "user",
      content: "See [the guide](https://example.com/guide).\n\nSecond line.",
    },
  },
  {
    message: {
      role: "thinking",
      content: "THINKING-BLOCK should not be copied.",
    },
    reasoning: { text: "REASONING-FIELD should not be copied." },
  },
  {
    message: {
      role: "assistant",
      content:
        "Use [the docs](vscode://file/c:/src/a.ts).\r\nKeep this newline.",
    },
    reasoning: { text: "ALSO-REASONING should not be copied." },
  },
  {
    message: {
      role: "tool",
      content: "Read [notes](file:///C:/src/notes.md).\nLine two.",
      toolCallId: "call_1",
    },
  },
];

const expected = `# Fixture chat

2026-11-19

## User

See [the guide](https://example.com/guide).

Second line.

## Assistant

Use [the docs](vscode://file/c:/src/a.ts).
Keep this newline.

## Tool

Read [notes](file:///C:/src/notes.md).
Line two.
`;

describe("conversationAsMarkdown", () => {
  it("copies a conversation as Markdown with a title and date", () => {
    const markdown = conversationAsMarkdown(history, {
      title: "Fixture chat",
      date: when,
    });

    expect(markdown).toBe(expected);
    expect(markdown).not.toContain("\r");
    expect(markdown).not.toContain("SYSTEM-PROMPT");
    expect(markdown).not.toContain("THINKING-BLOCK");
    expect(markdown).not.toContain("REASONING-FIELD");
    expect(markdown).not.toContain("ALSO-REASONING");
    expect(markdown.startsWith("# Fixture chat\n\n2026-11-19\n")).toBe(true);
  });

  it("offers plain text with links as text (url) and the same newlines", () => {
    const markdown = conversationAsMarkdown(history, {
      title: "Fixture chat",
      date: when,
    });
    const plain = markdownToPlainText(markdown);

    expect(plain).toBe(`Fixture chat

2026-11-19

User

See the guide (https://example.com/guide).

Second line.

Assistant

Use the docs (vscode://file/c:/src/a.ts).
Keep this newline.

Tool

Read notes (file:///C:/src/notes.md).
Line two.
`);
    expect(plain).not.toContain("ALSO-REASONING");
    expect(plain).not.toContain("](");
  });
});
