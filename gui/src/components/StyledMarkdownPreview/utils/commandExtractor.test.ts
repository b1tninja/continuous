import {
  collapseSpacesOutsideQuotes,
  COMMAND_SEPARATOR,
  extractCommand,
} from "./commandExtractor";

describe("extractCommand", () => {
  // Test basic command extraction
  it("should extract command from $ prompt", () => {
    expect(extractCommand("$ echo hello")).toBe("echo hello");
    expect(extractCommand("$  echo hello")).toBe("echo hello");
    // No space after `$`: a variable ($env:TEMP, $PATH), not a prompt
    expect(extractCommand("$echo hello")).toBe("$echo hello");
  });

  // Test comment removal
  it("should remove comments at beginning of lines", () => {
    expect(extractCommand("# shell comment\necho hello")).toBe("echo hello");
    expect(extractCommand("// js comment\necho hello")).toBe("echo hello");
    expect(extractCommand("/* multi-line\ncomment */\necho hello")).toBe(
      "echo hello",
    );
  });

  // Test multiline comment removal
  it("should remove multiline comments anywhere in the text", () => {
    expect(extractCommand("echo /* comment */ hello")).toBe("echo hello");
    expect(extractCommand("echo hello /* comment */")).toBe("echo hello");
    expect(extractCommand("echo /* multiple\nline\ncomment */ hello")).toBe(
      "echo hello",
    );
  });

  // Test line continuation handling
  it("should handle line continuations correctly", () => {
    expect(extractCommand("echo hello && \\\necho world")).toBe(
      "echo hello && echo world",
    );
    expect(extractCommand("echo hello | \\\ngrep h")).toBe(
      "echo hello | grep h",
    );
    expect(extractCommand("echo hello \\\nworld")).toBe("echo hello world");
  });

  // Test complex command combinations
  it("should handle complex command combinations", () => {
    expect(
      extractCommand(`
      # shell comment
      echo hello /* inline comment */ && \\
      // js comment
      echo world
    `),
    ).toBe("echo hello && echo world");
  });

  // Test empty and whitespace handling
  it("should handle empty and whitespace inputs", () => {
    expect(extractCommand("")).toBe("");
    expect(extractCommand("   \n   \t   ")).toBe("");
  });

  // Test comment-only inputs
  it("should handle comment-only inputs", () => {
    expect(extractCommand("/* comment */")).toBe("");
    expect(extractCommand("# comment")).toBe("");
    expect(extractCommand("// comment")).toBe("");
    expect(extractCommand("/* multi\nline\ncomment */")).toBe("");
  });

  // Test inline comments
  it("should handle inline comments correctly according to implementation", () => {
    // But removes multiline comments even when inline
    expect(extractCommand("/* inline */ echo hello world")).toBe(
      "echo hello world",
    );
  });

  // Test multiple line continuations
  it("should handle multiple line continuations", () => {
    expect(
      extractCommand(`
      echo hello && \\
      echo world && \\
      echo test
    `),
    ).toBe("echo hello && echo world && echo test");
  });

  // Test nested line continuations
  it("should handle nested line continuations", () => {
    expect(
      extractCommand(`
      echo hello && \\
      (echo nested && \\
       echo more) && \\
      echo final
    `),
    ).toBe("echo hello && (echo nested && echo more) && echo final");
  });

  // The block that broke: a PowerShell variable read as a "$ prompt" kept
  // only what followed the first `$`, and the other command was dropped
  it("keeps a PowerShell $env: variable and every command of the block", () => {
    const block = [
      "cd C:\\github\\b1tninja\\continued",
      "node --use-system-ca scratch_live.cjs",
      "node --use-system-ca scratch_runtime.cjs us.openai.gpt-6-luna > $env:TEMP\\live-runtime.txt",
    ].join("\n");
    expect(extractCommand(block)).toBe(
      [
        "cd C:\\github\\b1tninja\\continued",
        "node --use-system-ca scratch_live.cjs",
        "node --use-system-ca scratch_runtime.cjs us.openai.gpt-6-luna > $env:TEMP\\live-runtime.txt",
      ].join(COMMAND_SEPARATOR),
    );
  });

  it("keeps shell variables that are not prompts", () => {
    expect(extractCommand('echo "$HOME"')).toBe('echo "$HOME"');
    expect(extractCommand("echo $PATH | tr : '\\n'")).toBe(
      "echo $PATH | tr : '\\n'",
    );
    expect(extractCommand("$env:FOO = 1")).toBe("$env:FOO = 1");
  });

  it("strips prompts from every line", () => {
    expect(extractCommand("$ npm ci\n$ npm test")).toBe(
      `npm ci${COMMAND_SEPARATOR}npm test`,
    );
    expect(extractCommand("PS C:\\repo> git status")).toBe("git status");
    expect(extractCommand("> dir")).toBe("dir");
  });

  it("joins separate commands instead of running them as one", () => {
    expect(extractCommand("npm ci\nnpm test")).toBe(
      `npm ci${COMMAND_SEPARATOR}npm test`,
    );
  });

  it("keeps && and | when the next line continues the command", () => {
    expect(extractCommand("npm ci &&\nnpm test")).toBe("npm ci && npm test");
    expect(extractCommand("cat a.txt |\ngrep x")).toBe("cat a.txt | grep x");
  });

  it("joins PowerShell backtick continuations", () => {
    expect(extractCommand("Get-ChildItem `\n  -Recurse")).toBe(
      "Get-ChildItem -Recurse",
    );
  });

  it("keeps spacing inside quotes", () => {
    expect(extractCommand('git commit -m "two  spaces"')).toBe(
      'git commit -m "two  spaces"',
    );
    expect(extractCommand("echo  'a   b'   c")).toBe("echo 'a   b' c");
  });

  it("drops a trailing operator with nothing after it", () => {
    expect(extractCommand("npm ci &&")).toBe("npm ci");
  });

  it("handles Windows line endings", () => {
    expect(extractCommand("npm ci\r\nnpm test\r\n")).toBe(
      `npm ci${COMMAND_SEPARATOR}npm test`,
    );
  });
});

describe("collapseSpacesOutsideQuotes", () => {
  it("collapses runs of spaces and tabs outside quotes", () => {
    expect(collapseSpacesOutsideQuotes("a  \t b")).toBe("a b");
  });

  it("leaves quoted text alone, with either quote", () => {
    expect(collapseSpacesOutsideQuotes(`x "a  b" 'c  d'`)).toBe(
      `x "a  b" 'c  d'`,
    );
  });

  it("treats the other quote inside a quote as text", () => {
    expect(collapseSpacesOutsideQuotes(`"it's  ok"  next`)).toBe(
      `"it's  ok" next`,
    );
  });

  it("returns an empty string unchanged", () => {
    expect(collapseSpacesOutsideQuotes("")).toBe("");
  });
});
