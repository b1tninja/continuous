import { describe, expect, it } from "vitest";
import { detectShellHints, type HintTarget } from "./shellHints";

const PS51: HintTarget = { family: "powershell", version: "5.1" };
const PS7: HintTarget = { family: "powershell", version: "7" };
const PSUNKNOWN: HintTarget = { family: "powershell", version: "unknown" };
const BASH: HintTarget = { family: "posix" };
const CMD: HintTarget = { family: "cmd" };

const rules = (command: string, target: HintTarget) =>
  detectShellHints(command, target).map((h) => h.rule);

/**
 * The golden corpus. Each row was measured as written in the shell named
 * (plans/research/env-windows-shells-and-wsl.md, section 3) where it says
 * "measured"; the rest pin a false positive the detector must not raise.
 * The expected list is exact: a new finding on a row is a change to review.
 */
const CORPUS: [string, HintTarget, string[]][] = [
  // True positives under Windows PowerShell 5.1 (measured parse errors or silent failures)
  ["echo A && echo B", PS51, ["ps.chain-operator"]],
  ["cd nonexistent || echo FALLBACK", PS51, ["ps.chain-operator"]],
  [
    "cd app && npm install && npm test",
    PS51,
    ["ps.chain-operator", "ps.chain-operator"],
  ],
  ["cat <<'EOF' > hd.txt\nline\nEOF", PS51, ["ps.heredoc"]],
  ["cat <<EOF\nhello\nEOF", PS51, ["ps.heredoc"]],
  ['export FOO=bar; echo "foo=$FOO"', PS51, ["ps.bare-variable", "ps.export"]],
  ['FOO=bar node -e "console.log(process.env.FOO)"', PS51, ["ps.env-prefix"]],
  ["node script.js 2>/dev/null; echo OK", PS51, ["ps.dev-null"]],
  ["make > /dev/null", PS51, ["ps.dev-null"]],
  ["echo bg &", PS51, ["ps.background-amp"]],
  ["[ -d build ] && echo YES", PS51, ["ps.chain-operator", "ps.test-bracket"]],
  ['echo "in=`echo inner`"', PS51, ["ps.backtick-substitution"]],
  ['"C:\\Program Files\\nodejs\\node.exe" -v', PS51, ["ps.quoted-exe"]],
  ["set -e; echo X", PS51, ["ps.set-option"]],
  ["source .venv/bin/activate", PS51, ["ps.source"]],
  ["where node", PS51, ["ps.where-alias"]],
  ["curl -s https://example.com", PS51, ["ps.curl-alias"]],
  ["ls -la", PS51, ["ps.alias-flags"]],
  ["rm -rf build", PS51, ["ps.alias-flags"]],
  ["echo hello | grep hell", PS51, ["ps.unix-tool"]],
  [
    'node -e "console.log(JSON.parse(process.argv[1]).a)" \'{"a":1}\'',
    PS51,
    ["ps.json-argument"],
  ],
  ["cd /c/Windows; pwd", PS51, ["ps.posix-path"]],
  ["cd /mnt/c/Users; pwd", PS51, ["ps.posix-path"]],
  ['echo "path is $PATH"', PS51, ["ps.bare-variable"]],
  [
    'echo "rev=$(git rev-parse HEAD) n=$(wc -l file)"',
    PS51,
    ["ps.unix-substitution"],
  ],
  ["npm run build \\\n  --prod", PS51, ["ps.backslash-continuation"]],

  // False positives that must stay quiet under 5.1
  ['echo "a && b"', PS51, []],
  ["echo 'a || b'", PS51, []],
  ["# cd a && b\necho ok", PS51, []],
  ["<# a && b #>\necho ok", PS51, []],
  ["@'\ncd a && b\n'@ | Set-Content x.txt", PS51, []],
  ["bash -c 'cd a && make'", PS51, []],
  ['cmd /c "cd a && dir"', PS51, []],
  ["wsl -- ls -la /mnt/c/Users", PS51, []],
  ["Invoke-WebRequest -Uri 'https://x.test/?a=1&&b=2'", PS51, []],
  ['& "C:\\Program Files\\nodejs\\node.exe" -v', PS51, []],
  ['node -e "process.exit(3)"; if ($?) { echo ok }', PS51, []],
  ["$env:FOO='bar'; node app.js", PS51, []],
  ['echo "home=$HOME pwd=$PWD code=$LASTEXITCODE"', PS51, []],
  ["$X = 1; echo $X", PS51, []],
  ["node a.js 2>&1; echo $?", PS51, []],
  ["node a.js 2>$null", PS51, []],
  ["mkdir -p a/b/c", PS51, []],
  ["cp -r d1 d2", PS51, []],
  ["cat a.txt", PS51, []],
  ["ls -Force", PS51, []],
  ["Get-ChildItem -Name", PS51, []],
  ["curl.exe -s https://example.com", PS51, []],
  ["where.exe node", PS51, []],
  ['echo "total: $(1 + 1)"', PS51, []],
  ["Write-Output 'it''s && fine'", PS51, []],
  ["echo one `\n  two", PS51, []],
  ["git log --oneline -5 | Select-Object -First 2", PS51, []],

  // PowerShell 7 accepts the chain operators and a trailing &, and has no curl alias
  ["echo A && echo B", PS7, []],
  ["cd x || echo no", PS7, []],
  ["Start-Sleep 5 &", PS7, []],
  ["curl -s https://example.com", PS7, []],
  ['node -e "console.log(1)" \'{"a":1}\'', PS7, []],
  // ...but not bash's other syntax
  ["export FOO=bar", PS7, ["ps.export"]],
  ["cat <<EOF\nx\nEOF", PS7, ["ps.heredoc"]],

  // Bash reads all of this as intended
  ["echo A && echo B", BASH, []],
  ["cd x || echo no; [ -d . ] && echo YES", BASH, []],
  ["export FOO=bar; echo $FOO 2>/dev/null &", BASH, []],
  ["cat <<'EOF' > f\n$env:NOT_A_FINDING\nEOF", BASH, []],
  ["echo '$env:X'", BASH, []],
  // PowerShell written into bash
  ['echo "$env:EXP_VAR"', BASH, ["sh.ps-env"]],
  ["Get-ChildItem -Recurse", BASH, ["sh.cmdlet"]],
  ["@'\ntext\n'@ | Set-Content x", BASH, ["sh.cmdlet", "sh.here-string"]],
  ["cd C:\\Windows", BASH, ["sh.backslash-path"]],

  // cmd
  ["echo line1 > f; echo line2 >> f", CMD, ["cmd.semicolon"]],
  ["echo 'a & echo b'", CMD, ["cmd.single-quote"]],
  ["echo $env:USERNAME", CMD, ["cmd.dollar-var"]],
  ["cd /d C:\\x && dir /b", CMD, []],
  ['for /f "delims=;" %a in (x) do echo %a', CMD, []],
];

describe("shell hints: golden corpus", () => {
  it.each(CORPUS)("%j (%o)", (command, target, expected) => {
    expect(rules(command, target).sort()).toEqual([...expected].sort());
  });
});

describe("shell hints: details", () => {
  it("rewrites a simple chain as nested if ($?) blocks, as text only", () => {
    const [hint] = detectShellHints("cd app && npm test", PS51);
    expect(hint).toMatchObject({
      rule: "ps.chain-operator",
      severity: "error",
      start: 7,
      end: 9,
    });
    expect(hint.suggestion).toBe("cd app; if ($?) { npm test }");
    const three = detectShellHints("a && b && c", PS51)[0];
    expect(three.suggestion).toBe("a; if ($?) { b; if ($?) { c } }");
    expect(detectShellHints("a || b", PS51)[0].suggestion).toBe(
      "a; if (-not $?) { b }",
    );
  });

  it("falls back to the general form when the line is not a plain chain", () => {
    const hint = detectShellHints("a | b && c", PS51)[0];
    expect(hint.suggestion).toContain("if ($?)");
    expect(hint.suggestion).toContain("a; if ($?) { b }");
  });

  it("finds && outside quotes even when another && is inside them", () => {
    const hints = detectShellHints('echo "a && b" && echo c', PS51);
    expect(hints.map((h) => h.rule)).toEqual(["ps.chain-operator"]);
    expect(hints[0].start).toBe(14);
  });

  it("warns instead of erring when the PowerShell version is unknown", () => {
    const hints = detectShellHints("echo A && echo B &", PSUNKNOWN);
    expect(hints.map((h) => [h.rule, h.severity])).toEqual([
      ["ps.chain-operator", "warn"],
      ["ps.background-amp", "warn"],
    ]);
  });

  it("uses the session probe for Unix tools", () => {
    expect(rules("echo x | grep x", { ...PS51, unixTools: true })).toEqual([]);
    const [hint] = detectShellHints("echo x | grep x", {
      ...PS51,
      unixTools: false,
    });
    expect(hint).toMatchObject({ rule: "ps.unix-tool", severity: "error" });
    expect(hint.suggestion).toContain("Select-String");
  });

  it("gives the exact replacement where one exists", () => {
    const by = (command: string) =>
      Object.fromEntries(
        detectShellHints(command, PS51).map((h) => [h.rule, h.suggestion]),
      );
    expect(by("export NODE_ENV=production")["ps.export"]).toBe(
      "$env:NODE_ENV = 'production'",
    );
    expect(by("CI=1 npm test")["ps.env-prefix"]).toBe(
      "$env:CI = '1'; npm test",
    );
    expect(by("x 2>/dev/null")["ps.dev-null"]).toBe("2>$null");
    expect(by("where git")["ps.where-alias"]).toBe("where.exe git");
    expect(by("curl -sL https://x.test")["ps.curl-alias"]).toBe(
      "curl.exe -sL https://x.test",
    );
    expect(by('"C:\\tools\\x.exe" --help')["ps.quoted-exe"]).toBe(
      '& "C:\\tools\\x.exe" --help',
    );
    expect(by("cd /mnt/c/Users/me")["ps.posix-path"]).toBe("C:\\Users\\me");
    expect(by('echo "$USER"')["ps.bare-variable"]).toBe("$env:USER");
  });

  it("spans point at the text they are about", () => {
    const command = "npm ci; FOO=1 node x.js; echo done";
    for (const h of detectShellHints(command, PS51)) {
      expect(command.slice(h.start, h.end)).toBe("FOO=1");
    }
  });

  it("never throws on malformed text", () => {
    for (const command of [
      '"unterminated',
      "'",
      "@'",
      "<<",
      "`",
      "$(",
      "<#",
      "\\",
    ]) {
      for (const target of [PS51, PS7, BASH, CMD]) {
        expect(() => detectShellHints(command, target)).not.toThrow();
      }
    }
  });
});
