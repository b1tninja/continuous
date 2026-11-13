import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import {
  classifyInterpreter,
  decodeEncodedCommand,
  describeInterpreters,
  interpretersOfCommand,
  shebangInterpreter,
  type CommandInterpreter,
} from "./shellContext";

type Expect = Partial<
  Pick<
    CommandInterpreter,
    | "family"
    | "via"
    | "confidence"
    | "inner"
    | "script"
    | "elsewhere"
    | "opaque"
    | "changes"
    | "label"
  >
> & { chain?: string[] };

interface Row {
  outer: ShellKind;
  platform?: NodeJS.Platform;
  command: string;
  expect: Expect;
}

const encode = (text: string) =>
  Buffer.from(text, "utf16le").toString("base64");

/**
 * The golden corpus: one simple command, the shell it is handed to, and what
 * reads it. The rows that say `changes: false` are the false-positive cases:
 * ordinary commands that must not be reported as another interpreter.
 */
// prettier-ignore
const CORPUS: Row[] = [
  // --- nothing changes the interpreter
  { outer: "bash", command: "git status", expect: { family: "bash", via: "outer", confidence: "high", changes: false } },
  { outer: "powershell", command: "Get-ChildItem -Recurse", expect: { family: "powershell", via: "outer", changes: false } },
  { outer: "cmd", command: "dir /b", expect: { family: "cmd", via: "outer", changes: false } },
  { outer: "bash", command: "grep -c bash README.md", expect: { family: "bash", changes: false } },
  { outer: "bash", command: "echo 'bash -c rm'", expect: { family: "bash", changes: false } },
  { outer: "bash", command: "cat ./notes.txt", expect: { family: "bash", changes: false } },
  { outer: "bash", command: "/usr/bin/git log", expect: { family: "bash", changes: false } },
  { outer: "powershell", command: "C:\\tools\\rg.exe foo", expect: { family: "powershell", changes: false } },
  { outer: "bash", command: "find . -name '*.ts'", expect: { family: "bash", changes: false } },
  { outer: "powershell", command: "wsl --list --verbose", expect: { family: "powershell", changes: false } },
  { outer: "bash", command: "docker ps -a", expect: { family: "bash", changes: false } },
  { outer: "bash", command: "npm install", expect: { family: "bash", changes: false } },
  { outer: "bash", command: "FOO=1 BAR=2 node_modules/.bin/vitest run", expect: { family: "bash", changes: false } },
  { outer: "unknown", command: "ls", expect: { family: "unknown", via: "unknown", confidence: "low", changes: false } },

  // --- wrappers that keep the place and the interpreter: the program after them is what runs
  { outer: "bash", command: "sudo -u root git pull", expect: { family: "bash", changes: false, chain: ["sudo"] } },
  { outer: "bash", command: "env -u HOME A=1 timeout 5 nice -n 3 ls", expect: { family: "bash", changes: false, chain: ["env", "timeout", "nice"] } },
  { outer: "bash", command: "nohup time stdbuf -o L make", expect: { family: "sh", via: "script", script: "Makefile", opaque: true } },

  // --- a POSIX shell named on the command line
  { outer: "bash", command: "bash -c 'rm -rf build'", expect: { family: "bash", via: "wrapper", confidence: "high", inner: "rm -rf build", changes: true, label: "bash -c" } },
  { outer: "bash", command: "sh -euc 'echo a; echo b'", expect: { family: "sh", inner: "echo a; echo b", label: "sh -euc" } },
  { outer: "zsh", command: "zsh -c \"print -l *(e:'echo x':)\"", expect: { family: "zsh", inner: "print -l *(e:'echo x':)" } },
  { outer: "bash", command: "/usr/bin/env bash -lc 'npm test'", expect: { family: "bash", inner: "npm test", chain: ["env", "bash -lc"] } },
  { outer: "bash", command: "env -S 'bash -c \"echo hi\"'", expect: { family: "bash", inner: "echo hi", changes: true } },
  { outer: "bash", command: "fish -c 'set -x A 1; ls'", expect: { family: "fish", via: "wrapper", inner: "set -x A 1; ls" } },
  { outer: "bash", command: "ksh -c 'ls'", expect: { family: "unknown", confidence: "low", inner: "ls" } },
  { outer: "bash", command: "busybox sh -c 'ls'", expect: { family: "sh", inner: "ls", chain: ["busybox", "sh -c"] } },
  { outer: "bash", command: "bash deploy.sh --prod", expect: { family: "bash", via: "script", script: "deploy.sh", opaque: true, confidence: "medium" } },
  { outer: "bash", command: "bash", expect: { family: "bash", via: "unknown", opaque: true } },
  { outer: "bash", command: "bash --rcfile x.rc -c 'ls'", expect: { family: "bash", inner: "ls" } },
  // On Windows the word bash does not say which bash
  { outer: "powershell", platform: "win32", command: "bash -c 'uname -a'", expect: { family: "bash", confidence: "medium", inner: "uname -a" } },
  { outer: "cmd", platform: "win32", command: "sh -c \"ls\"", expect: { family: "sh", confidence: "medium", inner: "ls" } },

  // --- PowerShell named on the command line
  { outer: "bash", command: "pwsh -NoProfile -Command \"Get-Date\"", expect: { family: "powershell", via: "wrapper", inner: "Get-Date", label: "pwsh -Command" } },
  { outer: "cmd", command: "powershell -nop -ex bypass -c \"Remove-Item x\"", expect: { family: "powershell", inner: "Remove-Item x", label: "powershell -c" } },
  { outer: "cmd", command: "powershell -Command Get-ChildItem ; Remove-Item x", expect: { family: "powershell", inner: "Get-ChildItem ; Remove-Item x" } },
  { outer: "cmd", command: `powershell -EncodedCommand ${encode("Remove-Item canary")}`, expect: { family: "powershell", via: "wrapper", inner: "Remove-Item canary", opaque: false, confidence: "high" } },
  { outer: "cmd", command: `powershell -e ${encode("iex $x")}`, expect: { family: "powershell", inner: "iex $x" } },
  { outer: "cmd", command: `powershell -enc ${encode("whoami")}`, expect: { family: "powershell", inner: "whoami" } },
  { outer: "cmd", command: `pwsh /ec ${encode("whoami")}`, expect: { family: "powershell", inner: "whoami" } },
  { outer: "cmd", command: "powershell -enc not-base64!", expect: { family: "powershell", opaque: true, confidence: "low" } },
  { outer: "cmd", command: "powershell -ExecutionPolicy Bypass -File .\\build.ps1 -Clean", expect: { family: "powershell", via: "script", script: ".\\build.ps1", opaque: true } },
  { outer: "cmd", command: "powershell -Command -", expect: { family: "powershell", opaque: true, confidence: "low" } },
  { outer: "cmd", command: "powershell Get-Date", expect: { family: "powershell", via: "wrapper", inner: "Get-Date", confidence: "medium" } },
  { outer: "bash", command: "pwsh ./build.ps1", expect: { family: "powershell", via: "script", script: "./build.ps1", opaque: true } },
  { outer: "cmd", command: "powershell -NoExit", expect: { family: "powershell", opaque: true, confidence: "low" } },
  // -i is -Interactive (a switch) to pwsh and -InputFormat (takes a value) to powershell.exe
  { outer: "bash", command: "pwsh -i -c \"Get-Date\"", expect: { family: "powershell", via: "wrapper", inner: "Get-Date" } },
  { outer: "cmd", command: "powershell -i Text -c \"Get-Date\"", expect: { family: "powershell", via: "wrapper", inner: "Get-Date" } },
  { outer: "bash", command: "pwsh -inp Text -o XML -wd /tmp -c \"Get-Date\"", expect: { family: "powershell", inner: "Get-Date" } },
  // an en dash is a parameter dash to PowerShell
  { outer: "cmd", command: "powershell \u2013c \"whoami\"", expect: { family: "powershell", inner: "whoami" } },

  // --- cmd named on the command line
  { outer: "powershell", command: "cmd /c dir & del x", expect: { family: "cmd", via: "wrapper", inner: "dir & del x", label: "cmd /c" } },
  { outer: "powershell", command: "cmd.exe /d /s /c \"echo a && echo b\"", expect: { family: "cmd", inner: "echo a && echo b" } },
  { outer: "powershell", command: "cmd /K set", expect: { family: "cmd", inner: "set", label: "cmd /k" } },
  { outer: "bash", command: "cmd", expect: { family: "cmd", opaque: true, confidence: "low" } },

  // --- another place
  { outer: "powershell", command: "wsl -d Ubuntu -- ls -la /etc", expect: { family: "unknown", elsewhere: "wsl", confidence: "low", inner: "ls -la /etc", changes: true } },
  { outer: "powershell", command: "wsl.exe bash -lc \"make test\"", expect: { family: "bash", elsewhere: "wsl", inner: "make test", confidence: "high", chain: ["wsl", "bash -lc"] } },
  { outer: "powershell", command: "wsl -e ls", expect: { family: "unknown", elsewhere: "wsl", chain: ["wsl --exec"] } },
  { outer: "powershell", command: "wsl", expect: { elsewhere: "wsl", opaque: true, confidence: "low" } },
  { outer: "bash", command: "ssh -p 2222 -i key deploy@host 'sudo systemctl restart app'", expect: { family: "unknown", elsewhere: "remote", confidence: "low", inner: "sudo systemctl restart app" } },
  { outer: "bash", command: "ssh host", expect: { elsewhere: "remote", opaque: true } },
  { outer: "bash", command: "docker exec -it -u root web sh -c 'rm -rf /tmp/x'", expect: { family: "sh", elsewhere: "container", inner: "rm -rf /tmp/x", confidence: "high", chain: ["docker exec", "sh -c"] } },
  { outer: "bash", command: "docker run --rm -v \"$PWD:/w\" -w /w node:22 npm test", expect: { elsewhere: "container", changes: true } },
  { outer: "bash", command: "podman run --rm alpine", expect: { elsewhere: "container", opaque: true, confidence: "low" } },
  { outer: "bash", command: "docker run --frobnicate x alpine ls", expect: { elsewhere: "container", confidence: "low" } },
  { outer: "bash", command: "kubectl exec -n prod pod/web -- bash -c 'env'", expect: { family: "bash", elsewhere: "container", inner: "env" } },

  // --- a language interpreter
  { outer: "bash", command: "python3 -c \"import os; os.system('ls')\"", expect: { family: "python", via: "wrapper", inner: "import os; os.system('ls')", label: "python3 -c" } },
  { outer: "powershell", command: "node -e \"require('child_process').execSync('dir')\"", expect: { family: "node", inner: "require('child_process').execSync('dir')" } },
  { outer: "bash", command: "perl -e 'system(\"ls\")'", expect: { family: "perl", inner: 'system("ls")' } },
  { outer: "bash", command: "ruby -e 'puts 1'", expect: { family: "ruby", inner: "puts 1" } },
  { outer: "bash", command: "python manage.py migrate", expect: { family: "python", via: "script", script: "manage.py", opaque: true } },
  { outer: "bash", command: "node", expect: { family: "node", opaque: true } },

  // --- runners whose script is in another file
  { outer: "bash", platform: "linux", command: "npm run build", expect: { family: "sh", via: "script", script: "package.json", opaque: true } },
  { outer: "powershell", platform: "win32", command: "pnpm test", expect: { family: "cmd", via: "script", script: "package.json" } },

  // --- commands that run their arguments
  { outer: "bash", command: "watch -n 1 'ls | wc -l'", expect: { family: "sh", inner: "ls | wc -l", label: "sh -c (watch)" } },
  { outer: "bash", command: "eval \"$CMD\"", expect: { family: "bash", via: "wrapper", opaque: true, confidence: "low", changes: true } },
  { outer: "bash", command: "eval 'git push'", expect: { family: "bash", inner: "git push", confidence: "high", changes: true } },
  { outer: "bash", command: "xargs rm -f", expect: { opaque: true, confidence: "low", changes: true } },
  { outer: "bash", command: "find . -name '*.log' -exec sh -c 'rm \"$1\"' _ {} \\;", expect: { family: "sh", inner: 'rm "$1"', chain: ["find -exec", "sh -c"] } },
  { outer: "bash", command: "source ./env.sh", expect: { family: "bash", via: "script", script: "./env.sh", opaque: true } },
  { outer: "zsh", command: ". ~/.zshrc", expect: { family: "zsh", via: "script", opaque: true } },

  // --- PowerShell's own ways to run text or another program
  { outer: "powershell", command: "Invoke-Expression \"Remove-Item x\"", expect: { family: "powershell", inner: "Remove-Item x", changes: true } },
  { outer: "powershell", command: "iex $payload", expect: { family: "powershell", opaque: true, confidence: "low" } },
  { outer: "powershell", command: "& $tool --version", expect: { family: "unknown", opaque: true, confidence: "low" } },
  { outer: "powershell", command: "& .\\build.ps1 -Fast", expect: { family: "powershell", via: "script", script: ".\\build.ps1" } },
  { outer: "powershell", command: "& cmd /c ver", expect: { family: "cmd", inner: "ver" } },
  { outer: "powershell", command: "Start-Process cmd -ArgumentList '/c del x' -Wait", expect: { family: "cmd", inner: "/c del x", confidence: "low" } },
  { outer: "powershell", command: "Start-Process -FilePath $exe", expect: { family: "unknown", opaque: true, confidence: "low" } },
  { outer: "powershell", command: "start notepad", expect: { family: "program", confidence: "low", changes: true } },

  // --- a script named as the command: Windows shells go by extension
  { outer: "powershell", command: ".\\deploy.cmd prod", expect: { family: "cmd", via: "script", script: ".\\deploy.cmd", opaque: true } },
  { outer: "cmd", command: "build.bat", expect: { family: "cmd", via: "script" } },
  { outer: "cmd", command: "cleanup.js", expect: { family: "wsh", via: "script", label: "cleanup.js (Windows Script Host)" } },
  { outer: "powershell", command: ".\\legacy.vbs", expect: { family: "wsh" } },
  { outer: "cmd", command: "setup.ps1", expect: { family: "unknown", confidence: "low", opaque: true } },
  { outer: "powershell", command: ".\\setup.ps1", expect: { family: "powershell", via: "script", confidence: "medium" } },
  { outer: "powershell", command: ".\\deploy.sh", expect: { family: "unknown", via: "script", confidence: "low" } },
  { outer: "cmd", command: "tool.py --x", expect: { family: "python", confidence: "low" } },

  // --- a script named as the command: POSIX shells go by the first line, which is not read here
  { outer: "bash", command: "./deploy.sh --prod", expect: { family: "sh", via: "script", script: "./deploy.sh", opaque: true, confidence: "low" } },
  { outer: "bash", command: "./tool", expect: { family: "unknown", via: "script", confidence: "low" } },
  { outer: "bash", command: "../scripts/gen.py", expect: { family: "python", via: "script", confidence: "low" } },
  { outer: "bash", command: "sudo ./install.sh", expect: { via: "script", script: "./install.sh", chain: ["sudo"] } },
];

describe("classifyInterpreter: the golden corpus", () => {
  it.each(CORPUS.map((row) => [`${row.outer}: ${row.command}`, row] as const))(
    "%s",
    (_name, row) => {
      const got = classifyInterpreter(row.command, row.outer, {
        platform: row.platform ?? "linux",
      });
      expect(got).toMatchObject(row.expect);
    },
  );

  it("never throws and always answers, whatever the text", () => {
    for (const text of [
      "",
      "   ",
      "'",
      '"unterminated',
      "$(",
      "\u0000",
      "-",
      "& ",
      "wsl --",
      "env",
      "find -exec",
      "powershell -c",
      "bash -c",
    ]) {
      for (const outer of [
        "bash",
        "powershell",
        "cmd",
        "unknown",
        undefined,
      ] as const) {
        const got = classifyInterpreter(text, outer);
        expect(typeof got.label).toBe("string");
        expect(got.chain).toBeInstanceOf(Array);
      }
    }
  });

  it("gives up, as unknown and opaque, after eight launchers in a row", () => {
    const got = classifyInterpreter(`${"sudo ".repeat(9)}ls`, "bash");
    expect(got).toMatchObject({
      family: "unknown",
      confidence: "low",
      opaque: true,
    });
  });
});

describe("a script's first line, when the caller may read the file", () => {
  const read = (lines: Record<string, string>) => (path: string) => lines[path];

  it("names the interpreter from #!, whatever the file is called", () => {
    const got = classifyInterpreter("./deploy.sh --prod", "bash", {
      platform: "linux",
      readFirstLine: read({ "./deploy.sh": "#!/usr/bin/env node" }),
    });
    expect(got).toMatchObject({
      family: "node",
      via: "shebang",
      confidence: "high",
      script: "./deploy.sh",
      opaque: true,
      label: "./deploy.sh (#! node)",
    });
  });

  it("says the shell runs a file with no #! line", () => {
    const got = classifyInterpreter("./plain", "zsh", {
      platform: "linux",
      readFirstLine: read({ "./plain": "echo hi" }),
    });
    expect(got).toMatchObject({
      family: "zsh",
      via: "shebang",
      confidence: "medium",
    });
  });

  it("does not read a path with a variable, a glob or a home shortcut", () => {
    const asked: string[] = [];
    const readFirstLine = (path: string) => {
      asked.push(path);
      return "#!/bin/sh";
    };
    for (const command of [
      "./$name.sh",
      "./run-*.sh",
      "~/bin/tool.sh",
      "./{a,b}.sh",
    ]) {
      const got = classifyInterpreter(command, "bash", {
        platform: "linux",
        readFirstLine,
      });
      expect(got.confidence).toBe("low");
    }
    expect(asked).toEqual([]);
  });

  it("does not read a file on the other side of wsl, ssh or docker", () => {
    const asked: string[] = [];
    classifyInterpreter("wsl ./deploy.sh", "powershell", {
      readFirstLine: (p) => (asked.push(p), "#!/bin/sh"),
    });
    expect(asked).toEqual([]);
  });

  it("means nothing to PowerShell or cmd: the extension decides there", () => {
    const got = classifyInterpreter(".\\deploy.cmd", "powershell", {
      platform: "win32",
      readFirstLine: () => "#!/usr/bin/env python3",
    });
    expect(got.family).toBe("cmd");
  });

  it.each([
    ["#!/bin/sh", "sh", "sh"],
    ["#!/bin/bash -e", "bash", "bash"],
    ["#!/usr/bin/env python3", "python", "python3"],
    ["#!/usr/bin/env -S deno run --allow-read", "node", "deno"],
    ["#! /usr/bin/env FOO=1 zsh", "zsh", "zsh"],
    ["#!/usr/bin/pwsh", "powershell", "pwsh"],
    ["\uFEFF#!/usr/bin/perl -w", "perl", "perl"],
    ["#!/opt/custom/thing", "program", "thing"],
  ])("shebangInterpreter(%s)", (line, family, program) => {
    expect(shebangInterpreter(line)).toEqual({ family, program });
  });

  it.each(["", "echo hi", "# !/bin/sh", "#!", "#!   ", undefined])(
    "shebangInterpreter(%s) is not a #! line",
    (line) => {
      expect(shebangInterpreter(line)).toBeUndefined();
    },
  );
});

describe("decodeEncodedCommand", () => {
  it("decodes base64 of UTF-16LE, as -EncodedCommand takes it", () => {
    expect(decodeEncodedCommand(encode("Remove-Item 'a b' -Force"))).toBe(
      "Remove-Item 'a b' -Force",
    );
  });

  it.each(["", "abc", "not base64!", "QQ==", "QUJD"])("refuses %s", (text) => {
    expect(decodeEncodedCommand(text)).toBeUndefined();
  });
});

describe("interpretersOfCommand: a whole line and what is nested in it", () => {
  it("follows nested shells and reads each level with its own grammar", () => {
    const { readings, truncated } = interpretersOfCommand(
      "cd app && bash -c \"pwsh -c 'cmd /c dir & ver'\"",
      "bash",
      { platform: "linux" },
    );
    expect(truncated).toBe(false);
    expect(
      readings
        .slice(0, 5)
        .map((r) => [r.depth, r.interpreter.family, r.interpreter.label]),
    ).toEqual([
      [0, "bash", "bash"],
      [0, "bash", "bash -c"],
      [1, "powershell", "pwsh -c"],
      [2, "cmd", "cmd /c"],
      [3, "cmd", "cmd"],
    ]);
  });

  it("says when nesting goes deeper than it follows", () => {
    const { truncated } = interpretersOfCommand(
      `bash -c "bash -c 'bash -c ls'"`,
      "bash",
      { maxDepth: 1 },
    );
    expect(truncated).toBe(true);
  });

  it("does not split a language's code as if it were shell text", () => {
    const { readings } = interpretersOfCommand(
      `python -c "a = 1; print(a)"`,
      "bash",
    );
    expect(readings).toHaveLength(1);
  });
});

describe("with no outer shell known (a webview)", () => {
  it("still names a launcher, and says a script's interpreter is not known", () => {
    expect(describeInterpreters("git status", undefined)).toBeUndefined();
    expect(
      describeInterpreters("bash -c 'ls'", undefined, { platform: "linux" }),
    ).toEqual({
      text: "bash -c",
      uncertain: false,
      hidden: false,
    });
    expect(describeInterpreters("./deploy.sh", undefined)).toEqual({
      text: "./deploy.sh (a script: its first line, or on Windows its file type, names the interpreter)",
      uncertain: true,
      hidden: true,
    });
  });
});

describe("describeInterpreters: the line an approval card shows", () => {
  it("is absent when the shell itself reads all of the command", () => {
    expect(
      describeInterpreters("git status && npm test", "bash"),
    ).toBeUndefined();
    expect(
      describeInterpreters("Get-ChildItem | Select-Object Name", "powershell"),
    ).toBeUndefined();
    // true, and already plain in the command: no line of their own
    for (const command of [
      "npm test",
      "python manage.py migrate",
      "make build",
      "bash deploy.sh",
      "powershell -File x.ps1",
    ]) {
      expect(
        describeInterpreters(command, "bash", { platform: "linux" }),
      ).toBeUndefined();
    }
  });

  it("names a nested shell, outermost first", () => {
    expect(
      describeInterpreters("wsl bash -lc 'make test'", "powershell", {
        platform: "win32",
      }),
    ).toEqual({ text: "bash -lc in WSL", uncertain: false, hidden: false });
    expect(
      describeInterpreters(`bash -c "pwsh -c 'Get-Date'"`, "bash", {
        platform: "linux",
      }),
    ).toEqual({
      text: "bash -c, then pwsh -c",
      uncertain: false,
      hidden: false,
    });
  });

  it("says uncertain for a script, a remote shell and a decoded command it cannot read", () => {
    expect(
      describeInterpreters("./deploy.sh", "bash", { platform: "linux" })
        ?.uncertain,
    ).toBe(true);
    expect(describeInterpreters("ssh host uptime", "bash")?.uncertain).toBe(
      true,
    );
    expect(describeInterpreters("powershell -enc ###", "cmd")?.uncertain).toBe(
      true,
    );
  });
});
