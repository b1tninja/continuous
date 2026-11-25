import { describe, expect, it } from "vitest";
import { lintCommand } from "./commandLint";
import { shellHintDecision } from "./shellHints";

/**
 * Text inside a string, a here-string or a heredoc body is data for the program
 * that reads it, not shell syntax. A multi-line `python -c "..."` whose body
 * has `a=b + c` on a line, a `&&` in a string, or a `<<` shift is a valid
 * command; reading those lines as shell made the lint refuse commands that
 * would have run, and the agent then worked around a refusal that was wrong.
 */
const codes = (command: string, shell: "powershell" | "bash") =>
  lintCommand(command, shell).map((f) => f.code);

const POWERSHELL_OK: [string, string][] = [
  [
    "a multi-line python script in double quotes with name=value lines",
    'cd D:\\code\\gta6; python -c "\nimport sys\ntotal=len(sys.argv) + 1\nl0=sys.argv[:87]\nprint(total, l0)\n"',
  ],
  [
    "a && inside a double-quoted argument",
    'git commit -m "fix the parser && the lexer"',
  ],
  [
    "a && inside a single-quoted argument",
    "python -c 'import os; os.system(\"a && b\")'",
  ],
  [
    "a && in node code inside quotes",
    'node -e "const a = 1; const b = 2; if (a && b) console.log(a)"',
  ],
  ["a && inside a here-string", "$s = @'\ncd x && make\n'@\npython -c $s"],
  [
    "bash -c with a chained command in single quotes",
    "bash -c 'cd /tmp && ls'",
  ],
  [
    "a shift and an export line inside a quoted python body",
    'python -c "\nx = 1 << 3\nexport = 2\nexport FOO=1\n"',
  ],
  [
    "2>/dev/null inside a string",
    "python -c \"import subprocess; subprocess.run('ls 2>/dev/null', shell=True)\"",
  ],
  [
    "a && between backtick-escaped quotes in a string",
    'python -c "print(`"a && b`")"',
  ],
  ["a && in a string with doubled quotes", 'python -c "print(""a && b"")"'],
  [
    "a && in a single-quoted string with a doubled quote",
    "python -c 'print(''a && b'')'",
  ],
  ["a && in a PowerShell comment", "python x.py # then a && b"],
  ["a && inside a block comment", "python x.py <# a && b #>"],
  [
    "a long multi-line script in single quotes",
    "python -c '\nimport os\nx=os.getcwd() + \"/a\"\nif x and os.name: print(x)\ny=1 if x && 0 else 2\n'",
  ],
];

describe("PowerShell: code inside strings is not shell syntax", () => {
  for (const [name, command] of POWERSHELL_OK) {
    it(`${name} raises no lint finding and no shell hint`, () => {
      expect(codes(command, "powershell")).toEqual([]);
      expect(shellHintDecision(command, "powershell")).toBeUndefined();
    });
  }
});

describe("PowerShell: real shell mistakes are still found", () => {
  it("a bare && between commands", () => {
    expect(
      shellHintDecision(
        "cd D:\\code\\gta6 && python -m pytest -q",
        "powershell",
      )?.certain,
    ).toBe(true);
  });

  it("a bash heredoc", () => {
    expect(codes("python - <<'PY'\nprint(1)\nPY", "powershell")).toContain(
      "CL001",
    );
  });

  it("an export line outside any string", () => {
    expect(codes("export FOO=1\npython x.py", "powershell")).toContain("CL002");
  });

  it("NAME=value before a command outside any string", () => {
    expect(codes("FOO=1 python x.py", "powershell")).toContain("CL003");
  });
});

describe("bash: a heredoc body is data", () => {
  it("does not read PowerShell-looking lines in the body as the shell's dialect", () => {
    const command = "cat > x.ps1 <<'EOF'\nGet-ChildItem\n$env:PATH\nEOF";
    expect(codes(command, "bash")).not.toContain("CL004");
    expect(codes(command, "bash")).not.toContain("CL044");
  });
});
