// Reference solutions, one list of commands per task per shell. They are not
// shown to any model. `selftest` runs them on the host to prove each task is
// solvable there and each checker accepts a correct answer; `naive` holds the
// bash-style answer a model would write first, to prove the classifier names
// the failure on a real shell.

export const SOLUTIONS = {
  powershell: {
    ES01: [
      "New-Item -ItemType Directory -Force out | Out-Null; Set-Content out/a.txt alpha -NoNewline; Set-Content out/b.txt beta -NoNewline",
    ],
    ES02: [
      "New-Item -ItemType Directory build | Out-Null; if ($?) { Set-Content build/result.txt done -NoNewline }",
    ],
    ES03: ["Set-Content token.txt $env:TASK_TOKEN -NoNewline"],
    ES04: [
      `[System.IO.File]::WriteAllText("$PWD\\config.json", '{"name":"demo","tags":["a","b"],"note":"say \\"hi\\""}')`,
    ],
    ES05: ["node sum.js 3 4 5 | Set-Content sum.txt"],
    ES06: [
      "git checkout -b feature/x",
      `Add-Content notes.txt 'second line'; git add -A; git commit -q -m 'fix: handle \\"quoted\\" input'`,
    ],
    ES07: [
      "Import-Csv data.csv | Sort-Object { [int]$_.score } -Descending | Select-Object -First 3 -ExpandProperty name | Set-Content top3.txt",
    ],
    ES08: [
      `Get-ChildItem src -Recurse -File | Select-String -SimpleMatch -CaseSensitive TODO -List | ForEach-Object { (Resolve-Path -Relative $_.Path) -replace '\\\\','/' -replace '^\\./','' } | Sort-Object | Set-Content todo.txt`,
    ],
    ES09: [
      "New-Item -ItemType Directory -Force archive | Out-Null; Copy-Item 'my docs/report 1.txt' archive/report-1.txt; (Resolve-Path archive/report-1.txt).Path | Set-Content path.txt",
    ],
    ES10: [
      "Start-Process node -ArgumentList ticker.js -WindowStyle Hidden",
      "Start-Sleep 1; (Get-Content ticks.log).Count | Set-Content count.txt",
      "Stop-Process -Id (Get-Content ticker.pid)",
    ],
    // 5.1 strips double quotes inside a native argument, so the text is built from character codes
    ES11: [
      `node -e "require('fs').writeFileSync('q.txt',String.fromCharCode(72,101,32,115,97,105,100,32,34,105,116,39,115,32,102,105,110,101,34,32,38,32,108,101,102,116))"`,
    ],
    ES12: [
      `[System.IO.File]::WriteAllText("$PWD\\notes.txt", ((Get-Content notes.txt -Raw) -replace 'foo','bar'))`,
    ],
    ES13: ["node check.js; Set-Content code.txt $LASTEXITCODE -NoNewline"],
  },
  bash: {
    ES01: [
      "mkdir -p out && printf alpha > out/a.txt && printf beta > out/b.txt",
    ],
    ES02: ["mkdir build && printf done > build/result.txt"],
    ES03: [`printf '%s' "$TASK_TOKEN" > token.txt`],
    ES04: [
      `printf '%s' '{"name":"demo","tags":["a","b"],"note":"say \\"hi\\""}' > config.json`,
    ],
    ES05: ["node sum.js 3 4 5 > sum.txt"],
    ES06: [
      "git checkout -q -b feature/x",
      `echo 'second line' >> notes.txt && git add -A && git commit -q -m 'fix: handle "quoted" input'`,
    ],
    ES07: [
      "tail -n +2 data.csv | sort -t, -k2 -nr | head -3 | cut -d, -f1 > top3.txt",
    ],
    ES08: ["grep -rl TODO src | sort > todo.txt"],
    ES09: [
      `mkdir -p archive && cp 'my docs/report 1.txt' archive/report-1.txt && realpath archive/report-1.txt > path.txt`,
    ],
    ES10: [
      "node ticker.js > /dev/null 2>&1 &",
      "sleep 1; wc -l < ticks.log | tr -d ' ' > count.txt",
      // Git Bash on Windows: kill takes MSYS pids, the file holds a Windows pid
      process.platform === "win32"
        ? "taskkill //F //PID $(cat ticker.pid)"
        : "kill $(cat ticker.pid)",
    ],
    ES11: [
      `node -e 'require("fs").writeFileSync("q.txt", "He said \\"it\\u0027s fine\\" & left")'`,
    ],
    ES12: ["sed -i 's/foo/bar/g' notes.txt"],
    ES13: ["node check.js; echo $? > code.txt"],
  },
};

/** What a model writes first when it assumes bash; with the class it must get on PowerShell 5.1. */
export const NAIVE = [
  {
    id: "chain",
    shell: "powershell",
    command: "mkdir build && echo done > build/result.txt",
    expect: "parse-bashism",
  },
  {
    id: "env",
    shell: "powershell",
    command: "echo $TASK_TOKEN > token.txt",
    expect: "env-form-or-silent",
  },
  {
    id: "flags",
    shell: "powershell",
    command: "ls -la",
    expect: "alias-flags",
  },
  {
    id: "tool",
    shell: "powershell",
    // grep exists on a machine with Git for Windows on PATH; jq usually does not
    command: "jq . x",
    expect: "tool-missing",
  },
  {
    id: "devnull",
    shell: "powershell",
    command: "node ticker.js > /dev/null 2>&1",
    expect: "path-form",
  },
  {
    id: "foreign",
    shell: "bash",
    command: "Get-ChildItem -Recurse | Select-Object Name",
    expect: "foreign-syntax",
  },
];
