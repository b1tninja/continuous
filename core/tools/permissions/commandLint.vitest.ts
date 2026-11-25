import { beforeAll, describe, expect, it } from "vitest";
import {
  findHeredocs,
  commandLintGate,
  formatLint,
  resetCommandLintGate,
  lintCommand,
  type LintFinding,
} from "./commandLint";
import { initTreeSitterBash } from "./treeSitterBash";

beforeAll(async () => {
  expect(await initTreeSitterBash()).toBe(true);
});

const codes = (
  command: string,
  shell: Parameters<typeof lintCommand>[1] = "bash",
) => lintCommand(command, shell).map((f: LintFinding) => f.code);

describe("findHeredocs", () => {
  it("reads the delimiter, quoting and body", () => {
    const [h] = findHeredocs("cat > a.txt <<'EOF'\nline $1\nEOF\n");
    expect(h).toMatchObject({ delimiter: "EOF", quoted: true, endLine: 2 });
    expect(h.body).toEqual(["line $1"]);
  });

  it("treats <<< as a here-string and ignores << inside quotes", () => {
    expect(findHeredocs("grep x <<< hello")).toEqual([]);
    expect(findHeredocs('echo "a <<EOF b"')).toEqual([]);
  });

  it("strips tabs for <<-", () => {
    const [h] = findHeredocs("cat <<-EOF\n\tbody\n\tEOF\n");
    expect(h.endLine).toBe(2);
  });
});

describe("heredoc mistakes", () => {
  it("warns when a heredoc writes a file", () => {
    expect(codes("cat > src/a.ts <<'EOF'\nconst a = 1;\nEOF")).toContain(
      "CL010",
    );
    expect(codes("tee notes.md <<'EOF'\nx\nEOF")).toContain("CL010");
  });

  it("leaves a heredoc that only feeds a command alone", () => {
    expect(codes("python3 - <<'PY'\nprint(1)\nPY")).toEqual([]);
    expect(codes("cat <<'EOF'\nhi\nEOF")).toEqual([]);
  });

  it("warns that an unquoted delimiter expands the body", () => {
    const found = lintCommand(
      'cat > run.sh <<EOF\necho "$HOME" `date` \\n\nEOF',
      "bash",
    );
    expect(found.map((f) => f.code)).toContain("CL022");
    expect(found.find((f) => f.code === "CL022")?.advice).toContain("<<'EOF'");
  });

  it("is quiet about an unquoted delimiter with a plain body", () => {
    expect(codes("cat <<EOF\nplain text\nEOF")).toEqual([]);
  });

  it("errors on a heredoc that never ends", () => {
    const found = lintCommand("cat > a <<EOF\nhello\n", "bash");
    expect(found[0]).toMatchObject({ code: "CL020", severity: "error" });
  });

  it("errors on an indented closing line (SC1039)", () => {
    const found = lintCommand("cat <<EOF\nhello\n  EOF\nEOF", "bash");
    expect(found.map((f) => f.code)).toContain("CL021");
  });
});

describe("escaping mistakes", () => {
  it("flags echo writing a file with backslash escapes", () => {
    expect(codes('echo "a\\nb" > out.txt')).toContain("CL011");
    expect(codes("echo hi > out.txt")).not.toContain("CL011");
  });

  it("flags echo \\n without -e", () => {
    expect(codes('echo "one\\ntwo"')).toContain("CL012");
    expect(codes('echo -e "one\\ntwo"')).not.toContain("CL012");
  });

  it('flags a long inline script in double quotes that uses $ or \\"', () => {
    const script =
      'python3 -c "import os\nprint(\\"hello\\", os.environ[\\"HOME\\"], \\"and a longer text here\\")"';
    expect(codes(script)).toContain("CL030");
    expect(codes("python3 -c 'print(1)'")).not.toContain("CL030");
  });
});

describe("syntax", () => {
  it("reports a syntax error with its position", () => {
    const found = lintCommand("echo 'unterminated", "bash");
    expect(found[0]).toMatchObject({ code: "CL000", severity: "error" });
    expect(found[0].message).toMatch(/line 1/);
  });

  it("is quiet about valid commands", () => {
    expect(codes("git status && npm test | tail -5")).toEqual([]);
    expect(codes('for f in *.ts; do echo "$f"; done')).toEqual([]);
  });
});

describe("the shell that runs it", () => {
  it("errors on a bash heredoc in PowerShell", () => {
    const found = lintCommand("cat > a.txt <<'EOF'\nhi\nEOF", "powershell");
    expect(found[0]).toMatchObject({ code: "CL001", severity: "error" });
  });

  it("errors on export and NAME=value in PowerShell", () => {
    expect(codes("export A=1", "powershell")).toContain("CL002");
    expect(codes("A=1 node x.js", "powershell")).toContain("CL003");
  });

  it("does not read PowerShell here-strings or -eq as bash mistakes", () => {
    expect(codes("$a = @'\nhi\n'@; Write-Output $a", "powershell")).toEqual([]);
    expect(
      codes("Get-ChildItem | Where-Object { $_.Name -eq 'a' }", "powershell"),
    ).toEqual([]);
  });

  it("notes PowerShell in a POSIX shell", () => {
    expect(codes("$env:PATH", "bash")).toContain("CL004");
  });

  it("does not lint a shell it does not know", () => {
    expect(codes("cat <<EOF\nhi", "unknown")).toEqual([]);
  });
});

describe("formatLint", () => {
  it("says not run, with the fix, and never invites sending the same command again", () => {
    const err = formatLint(lintCommand("cat <<EOF\nx\n", "bash"));
    expect(err).toContain("was not run");
    expect(err).toContain("refused the same way");
    expect(err).toContain("create_new_file");
    expect(err).not.toContain("call again with exactly the same command");
    const warn = formatLint(lintCommand("cat > a <<'EOF'\nx\nEOF", "bash"));
    expect(warn).not.toContain("exactly the same command");
  });
});

describe("commandLintGate", () => {
  const heredocWrite = "cat > a.txt <<'EOF'\nx\nEOF";

  it("lets a clean command through", () => {
    resetCommandLintGate();
    expect(commandLintGate("git status", "bash", {})).toBeUndefined();
  });

  it("lets a likely mistake run, every time, with nothing to resend", () => {
    resetCommandLintGate();
    expect(commandLintGate(heredocWrite, "bash", {})).toBeUndefined();
    expect(commandLintGate(heredocWrite, "bash", {})).toBeUndefined();
  });

  it("always stops a certain mistake", () => {
    resetCommandLintGate();
    const bad = "cat <<EOF\nnever ends";
    expect(commandLintGate(bad, "bash", {})).toContain("was not run");
    expect(commandLintGate(bad, "bash", {})).toContain("was not run");
  });

  it("is off with CONTINUE_COMMAND_LINT=off", () => {
    resetCommandLintGate();
    expect(
      commandLintGate(heredocWrite, "bash", { CONTINUE_COMMAND_LINT: "off" }),
    ).toBeUndefined();
  });
});
