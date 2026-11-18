// Parser oracles for the detector: ask the real shell's PARSER whether a
// command is syntactically valid, without running it. Windows PowerShell 5.1:
// [System.Management.Automation.Language.Parser]::ParseInput. bash: `bash -n`.
// Used to measure the detector's "certain" signals (parse-level) against the
// shell itself: a certain signal on a command the parser accepts is a false
// positive; a parse error with no certain signal is a miss. Nothing here
// executes a command.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialectSignals } from "./classify.mjs";

const PS_SCRIPT = `
$cmds = ConvertFrom-Json (Get-Content -Raw -Encoding UTF8 $env:ORACLE_IN)
$res = New-Object System.Collections.ArrayList
foreach ($c in $cmds) {
  $errs = $null; $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput([string]$c, [ref]$tokens, [ref]$errs)
  [void]$res.Add([bool]($errs -and $errs.Count -gt 0))
}
ConvertTo-Json -Compress -InputObject @($res) | Set-Content -Encoding UTF8 $env:ORACLE_OUT
`;

/** For each command: true when Windows PowerShell 5.1 cannot parse it. */
export function powershellParseErrors(commands) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envshell-oracle-"));
  try {
    const inp = path.join(dir, "in.json");
    const out = path.join(dir, "out.json");
    const ps1 = path.join(dir, "oracle.ps1");
    fs.writeFileSync(inp, JSON.stringify(commands));
    fs.writeFileSync(ps1, PS_SCRIPT);
    const r = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
      {
        env: { ...process.env, ORACLE_IN: inp, ORACLE_OUT: out },
        encoding: "utf8",
        timeout: 120000,
      },
    );
    if (!fs.existsSync(out))
      throw new Error(
        `the PowerShell oracle produced nothing: ${r.stderr?.slice(0, 200)}`,
      );
    const raw = fs.readFileSync(out, "utf8").replace(/^﻿/, "");
    return JSON.parse(raw);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** For each command: true when `bash -n` rejects it. */
export function bashParseErrors(commands, bashPath = "bash") {
  return commands.map(
    (c) =>
      spawnSync(bashPath, ["-n", "-c", c], { encoding: "utf8", timeout: 20000 })
        .status !== 0,
  );
}

/**
 * Confusion matrix of the detector's CERTAIN signals against a parser's
 * verdict. `errors[i]` is true when the parser rejected commands[i].
 */
export function confusion(commands, errors, shell) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const falsePositives = [];
  const misses = [];
  commands.forEach((c, i) => {
    const flagged = dialectSignals(c, shell).some((s) => s.certain);
    if (flagged && errors[i]) tp++;
    else if (flagged) {
      fp++;
      falsePositives.push(c);
    } else if (errors[i]) {
      fn++;
      misses.push(c);
    } else tn++;
  });
  return { n: commands.length, tp, fp, fn, tn, falsePositives, misses };
}
