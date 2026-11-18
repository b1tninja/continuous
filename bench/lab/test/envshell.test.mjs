import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runTask } from "../envshell/agent.mjs";
import { ARM_IDS, buildArm, hintFor, preflight } from "../envshell/arms.mjs";
import {
  checkJson,
  checkText,
  lines,
  samePath,
  toNativePath,
} from "../envshell/checkers.mjs";
import {
  blankQuoted,
  classifyOutcome,
  dialectFamily,
  dialectSignals,
  encodingProblem,
  familyFlips,
  inspectBytes,
  isTranslationRetry,
} from "../envshell/classify.mjs";
import { assertOutside, planNumbers } from "../envshell/cli.mjs";
import {
  commandsInJson,
  commandsInText,
  summarize,
} from "../envshell/replay.mjs";
import {
  formatReport,
  metrics,
  pairedCompare,
  pairedPower,
} from "../envshell/report.mjs";
import { SOLUTIONS } from "../envshell/solutions.mjs";
import { TASKS, taskById } from "../envshell/tasks.mjs";

const codes = (c, s) => dialectSignals(c, s).map((x) => x.code);

test("detector: bash text read by PowerShell 5.1", () => {
  assert.ok(codes("cd src && npm test", "powershell").includes("S001"));
  assert.ok(
    codes("cat <<'EOF' > a.txt\nx\nEOF", "powershell").includes("S002"),
  );
  assert.ok(codes("export FOO=1", "powershell").includes("S003"));
  assert.ok(codes("FOO=1 node app.js", "powershell").includes("S004"));
  assert.ok(codes("echo $USER", "powershell").includes("S020"));
  assert.ok(codes("ls -la", "powershell").includes("S040"));
  assert.ok(codes("rm -rf build", "powershell").includes("S041"));
  assert.ok(codes("curl -s https://x", "powershell").includes("S042"));
  assert.ok(codes("grep -rn foo src", "powershell").includes("S050"));
  assert.ok(codes("node a.js > /dev/null", "powershell").includes("S030"));
  assert.ok(codes("cd /mnt/c/work", "powershell").includes("S031"));
});

test("detector: no false alarms on text in the right dialect", () => {
  for (const c of [
    "Get-ChildItem -Force | Select-Object Name",
    "$env:FOO = 'x'; node app.js",
    "git commit -m 'a && b'",
    'git commit -m "x || y"',
    "Write-Host $HOME",
    'node -e "console.log(1)"',
    "git status",
    "curl.exe -s https://x",
    "if ($?) { node a.js }",
  ])
    assert.deepEqual(codes(c, "powershell"), [], c);
  for (const c of [
    "ls -la 2>/dev/null && echo done",
    "if [ $a -eq 1 ]; then echo ok; fi",
    "echo $HOME",
    "grep -r x .",
  ])
    assert.deepEqual(
      codes(c, "bash").filter((x) => x !== "S007"),
      [],
      c,
    );
});

test("detector: PowerShell and cmd text read by bash", () => {
  assert.ok(
    codes("Get-ChildItem | Where-Object { $_.Length -gt 1 }", "bash").includes(
      "S060",
    ),
  );
  assert.ok(codes("echo $env:PATH", "bash").includes("S023"));
  assert.ok(codes("dir /b && echo %USERPROFILE%", "bash").includes("S063"));
  assert.ok(codes("dir /b && echo %USERPROFILE%", "bash").includes("S021"));
  assert.ok(codes("cd C:\\Users\\me\\proj", "bash").includes("S033"));
  assert.ok(
    codes("if [ $x -eq 1 ]; then echo a; fi", "bash").indexOf("S062") === -1,
  );
});

test("detector: cmd", () => {
  assert.ok(codes("echo $HOME", "cmd").includes("S022"));
  assert.ok(codes("export A=1", "cmd").includes("S003"));
  assert.deepEqual(codes("dir /b && echo %USERPROFILE%", "cmd"), []);
});

test("blankQuoted keeps length and blanks inside quotes", () => {
  const t = `echo 'a && b' && echo "x || y"`;
  const b = blankQuoted(t);
  assert.equal(b.length, t.length);
  assert.ok(!/a && b/.test(b));
  assert.ok(/&& echo/.test(b));
});

test("dialect family", () => {
  assert.equal(dialectFamily("cd a && ls -la"), "posix");
  assert.equal(
    dialectFamily("Get-ChildItem | Select-Object Name"),
    "powershell",
  );
  assert.equal(dialectFamily("git status"), "neutral");
});

test("classifyOutcome: the output and the text decide", () => {
  const ps = (command, exitCode, stderr = "", stdout = "", timedOut = false) =>
    classifyOutcome({
      command,
      shell: "powershell",
      exitCode,
      stderr,
      stdout,
      timedOut,
    });
  assert.equal(
    ps(
      "a && b",
      1,
      "ParserError: The token '&&' is not a valid statement separator",
    ).cls,
    "parse-bashism",
  );
  assert.equal(
    ps(
      "ls -la",
      1,
      "A parameter cannot be found that matches parameter name 'la'",
    ).cls,
    "alias-flags",
  );
  assert.equal(
    ps(
      "grep x f",
      1,
      "grep : The term 'grep' is not recognized as the name of a cmdlet",
    ).cls,
    "tool-missing",
  );
  assert.equal(
    ps("cat > /tmp/x", 1, "Could not find a part of the path 'C:\\tmp\\x'").cls,
    "path-form",
  );
  assert.equal(ps("node a.js", 1, "Error: Cannot find module").cls, "other");
  assert.equal(ps("sleep 100", null, "", "", true).cls, "hang");
  assert.equal(ps("echo hi", 0).failed, false);
  const silent = ps("echo $TASK_TOKEN > token.txt", 0);
  assert.equal(silent.failed, false);
  const noisy = ps("mkdir a && echo b", 0, "");
  assert.equal(noisy.silent, true);
  // PowerShell error records with exit 0 are failures
  assert.equal(
    ps(
      "Get-Item nope",
      0,
      "Get-Item : Cannot find path 'C:\\nope'\n+ CategoryInfo : ObjectNotFound",
    ).failed,
    true,
  );
  const b = classifyOutcome({
    command: "Get-ChildItem",
    shell: "bash",
    exitCode: 127,
    stderr: "bash: Get-ChildItem: command not found",
  });
  assert.equal(b.cls, "foreign-syntax");
});

test("translation retry and oscillation", () => {
  const a = { command: "mkdir b && cd b", failed: true, cls: "parse-bashism" };
  const b = { command: "mkdir b; cd b", failed: false, cls: "ok" };
  assert.equal(isTranslationRetry(a, b, "powershell"), true);
  assert.equal(isTranslationRetry(a, a, "powershell"), false);
  assert.equal(
    isTranslationRetry({ ...a, cls: "other" }, b, "powershell"),
    false,
  );
  assert.equal(
    familyFlips([
      "ls -la && pwd",
      "Get-ChildItem | Select-Object Name",
      "rm -rf x && ls -la",
    ]),
    2,
  );
  assert.equal(familyFlips(["git status", "git log"]), 0);
});

test("encoding inspection", () => {
  assert.equal(encodingProblem(Buffer.from("hi\n")), null);
  assert.equal(encodingProblem(Buffer.from([0xef, 0xbb, 0xbf, 0x68])), "bom");
  assert.equal(encodingProblem(Buffer.from([0xff, 0xfe, 0x68, 0x00])), "utf16");
  assert.equal(encodingProblem(Buffer.from("a\r\nb\r\n")), "crlf");
  assert.equal(inspectBytes(Buffer.from("a\r\nb\n")).mixed, true);
});

test("checkers", () => {
  assert.equal(checkText(Buffer.from("alpha"), "alpha").pass, true);
  assert.equal(checkText(Buffer.from("alpha\r\n"), "alpha").pass, true);
  assert.equal(
    checkText(Buffer.from("alpha\r\n"), "alpha", { allowCrlf: false }).pass,
    false,
  );
  assert.equal(checkText(Buffer.from("\ufeffalpha"), "alpha").pass, false);
  assert.equal(
    checkText(Buffer.from("alpha", "utf16le"), "alpha").encoding,
    "utf16",
  );
  assert.equal(
    checkText(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("alpha", "utf16le"),
      ]),
      "alpha",
    ).encoding,
    "utf16",
  );
  assert.equal(checkText(null, "x").pass, false);
  const j = { a: [1, 2], s: 'q"' };
  assert.equal(checkJson(Buffer.from(JSON.stringify(j)), j).pass, true);
  assert.equal(
    checkJson(Buffer.from(`\ufeff${JSON.stringify(j)}`), j).pass,
    false,
  );
  assert.equal(checkJson(Buffer.from("{bad"), j).pass, false);
  assert.deepEqual(lines(Buffer.from("\ufeffa\r\n\r\nb \n")), ["a", "b"]);
});

test("paths from any host", () => {
  assert.equal(toNativePath("/mnt/c/x/y", "win32"), "C:\\x\\y");
  assert.equal(toNativePath("/c/x/y", "win32"), "C:\\x\\y");
  assert.equal(toNativePath("C:/x/y", "win32"), "C:\\x\\y");
  assert.equal(toNativePath('"C:\\x\\y"', "win32"), "C:\\x\\y");
  assert.equal(
    toNativePath("/tmp/a", "win32", "D:\\t"),
    path.join("D:\\t", "a"),
  );
  assert.equal(toNativePath("C:\\x", "linux"), "/mnt/c/x");
  assert.equal(samePath("C:\\X\\y", "c:/x/y/", "win32"), true);
  assert.equal(samePath("/a/B", "/a/b", "linux"), false);
});

test("every task has a reference solution per shell and a prompt that names no shell", () => {
  assert.equal(TASKS.length, 13);
  for (const t of TASKS) {
    for (const shell of Object.keys(SOLUTIONS))
      assert.ok(SOLUTIONS[shell][t.id]?.length >= 1, `${shell} ${t.id}`);
    const p = t.prompt({});
    assert.ok(
      !/powershell|bash|cmd\.exe|shell/i.test(p),
      `${t.id} names a shell`,
    );
    assert.ok(t.minCommands >= 1);
  }
  assert.equal(taskById("ES02").id, "ES02");
});

test("arms: the same task text, different environment text", () => {
  const host = { shell: "powershell" };
  const built = Object.fromEntries(
    ARM_IDS.map((a) => [a, buildArm(a, host, "D:\\work")]),
  );
  assert.ok(
    !/PowerShell|Windows|win32/i.test(
      built.A0.system + built.A0.toolDescription,
    ),
  );
  assert.ok(/Platform: win32/.test(built.A1.system));
  assert.ok(/not &&/.test(built.A1.toolDescription));
  assert.ok(/shell powershell\.exe/.test(built.A1i.toolDescription));
  assert.ok(!/&&/.test(built.A1i.toolDescription));
  assert.ok(/Windows PowerShell 5\.1/.test(built.A2.system));
  assert.ok(built.A3.system.includes("<environment>"));
  assert.equal(built.A3.guidanceSha, built.A4.guidanceSha);
  assert.equal(built.A4.hintOn, true);
  assert.equal(built.A5.preflightOn, true);
  assert.equal(built.A6.shell, "wsl");
  assert.ok(/WSL/.test(built.A6.system));
  assert.ok(built.A7.system.includes("bash"));
  assert.notEqual(built.A7.guidanceSha, built.A3.guidanceSha);
  assert.throws(() => buildArm("A9", host, "x"));
});

test("hint and pre-flight", () => {
  const out = classifyOutcome({
    command: "a && b",
    shell: "powershell",
    exitCode: 1,
    stderr: "ParserError",
  });
  assert.match(hintFor(out, "powershell"), /Windows PowerShell 5\.1/);
  assert.equal(hintFor({ failed: true, cls: "other" }, "powershell"), null);
  assert.equal(hintFor({ failed: false, cls: "ok" }, "powershell"), null);
  assert.ok(preflight("cd a && b", "powershell"));
  assert.equal(preflight("ls -la", "powershell"), null); // a hint, not certain: it still runs
  assert.equal(preflight("cd a && b", "bash"), null);
});

// a scripted model and a fake shell: the whole loop, no process, no network
function scripted(commands) {
  let i = 0;
  return async () => {
    const c = commands[i++];
    const usage = { promptTokens: 100, completionTokens: 10 };
    if (c === undefined) return { message: { content: "done" }, usage };
    return {
      message: {
        content: null,
        tool_calls: [
          {
            id: `c${i}`,
            function: {
              name: "run_command",
              arguments: JSON.stringify({ command: c }),
            },
          },
        ],
      },
      usage,
    };
  };
}

test("agent loop: a bash-ism, a hint, a rewrite, a pass", async () => {
  const task = taskById("ES03");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envshell-test-"));
  const seen = [];
  const exec = async (shell, command, { cwd, env }) => {
    seen.push(command);
    if (command.includes("&&"))
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "ParserError: The token '&&' is not a valid statement separator",
        timedOut: false,
      };
    fs.writeFileSync(path.join(cwd, "token.txt"), env.TASK_TOKEN);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const rec = await runTask({
    task,
    armId: "A4",
    host: { shell: "powershell" },
    dir,
    token: "tok-1",
    model: "m",
    chat: scripted(["cd . && echo x", "Set-Content token.txt $env:TASK_TOKEN"]),
    exec,
  });
  assert.equal(rec.pass, true);
  assert.equal(rec.turns, 3);
  assert.equal(rec.commands, 2);
  assert.equal(rec.firstTryFailed, true);
  assert.equal(rec.hinted, 1);
  assert.equal(rec.translationRetries, 1);
  assert.deepEqual(rec.classes, { "parse-bashism": 1 });
  assert.equal(rec.usage.promptTokens, 300);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent loop: arm A5 does not run a certain bash-ism", async () => {
  const task = taskById("ES02");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envshell-test-"));
  let ran = 0;
  const exec = async (shell, command, { cwd }) => {
    ran++;
    fs.mkdirSync(path.join(cwd, "build"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "build", "result.txt"), "done");
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const rec = await runTask({
    task,
    armId: "A5",
    host: { shell: "powershell" },
    dir,
    token: "t",
    model: "m",
    chat: scripted(["mkdir build && echo done", "mkdir build; echo done"]),
    exec,
  });
  assert.equal(ran, 1);
  assert.equal(rec.rejected, 1);
  assert.equal(rec.pass, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent loop: an endpoint error is recorded, not thrown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envshell-test-"));
  const rec = await runTask({
    task: taskById("ES01"),
    armId: "A0",
    host: { shell: "bash" },
    dir,
    token: "t",
    model: "m",
    chat: async () => {
      throw new Error("HTTP 500");
    },
    exec: async () => ({}),
  });
  assert.equal(rec.finish, "error");
  assert.equal(rec.pass, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replay: extraction and summary", () => {
  assert.deepEqual(
    commandsInJson({ a: [{ command: "ls" }, { args: { command: "pwd" } }] }),
    ["ls", "pwd"],
  );
  assert.deepEqual(commandsInJson({ arguments: '{"command":"git status"}' }), [
    "git status",
  ]);
  assert.deepEqual(
    commandsInText('{"command":"a"}\nnot json\n{"command":"b"}', ".jsonl"),
    ["a", "b"],
  );
  assert.deepEqual(
    commandsInText("x({ command: \"a && b\" }); y({ command: 'c' })", ".ts"),
    ["a && b", "c"],
  );
  const s = summarize(
    ["cd a && ls -la", "git status", "git status", "Write-Host hi"],
    "powershell",
  );
  assert.equal(s.n, 3);
  assert.equal(s.withSignal, 1);
  assert.equal(s.certain, 1);
  assert.equal(s.byClass["parse-bashism"], 1);
});

test("report: metrics, pairing, power", () => {
  const mk = (arm, task, rep, pass, first) => ({
    model: "m",
    arm,
    task,
    rep,
    pass,
    firstTryFailed: first,
    failedCommands: first ? 1 : 0,
    turns: 3,
    extraCommands: 0,
    usage: { promptTokens: 1000, completionTokens: 100 },
    translationRetries: 0,
    familyFlips: 0,
    rejected: 0,
    hinted: 0,
    classes: first ? { "parse-bashism": 1 } : {},
  });
  const recs = [];
  for (let r = 1; r <= 30; r++) {
    recs.push(mk("A0", "ES02", r, r > 20, r <= 20));
    recs.push(mk("A3", "ES02", r, r > 5, r <= 5));
  }
  const m = metrics(
    recs.filter((x) => x.arm === "A0"),
    { in: 1, out: 5 },
  );
  assert.equal(m.n, 30);
  assert.equal(m.success.k, 10);
  assert.ok(
    Math.abs(m.costPerSolved - (30 * (1000 * 1 + 100 * 5)) / 1e6 / 10) < 1e-9,
  );
  const c = pairedCompare(
    recs.filter((x) => x.arm === "A0"),
    recs.filter((x) => x.arm === "A3"),
  );
  assert.equal(c.pairs, 30);
  assert.equal(c.success.onlyB, 15);
  assert.equal(c.success.onlyA, 0);
  assert.ok(c.success.p < 0.001);
  assert.ok(c.success.ci.lo > 0);
  assert.match(formatReport(recs, { baseline: "A0" }), /Paired against A0/);
  assert.ok(pairedPower(100, 0.05, 0.25) > 0.9);
  assert.ok(pairedPower(30, 0.05, 0.15) < 0.5);
  assert.equal(pairedPower(50, 0, 0), 0);
});

test("cli guards and plan arithmetic", () => {
  assert.throws(
    () => assertOutside(path.resolve(import.meta.dirname, "..", "results")),
    /inside the repository/,
  );
  assert.doesNotThrow(() => assertOutside(path.join(os.tmpdir(), "x")));
  const p = planNumbers({
    models: ["a"],
    arms: ["A0", "A3"],
    tasks: ["ES01", "ES02"],
    reps: 3,
    price: { in: 2, out: 10 },
  });
  assert.equal(p.runs, 12);
  assert.equal(p.requests, 42);
  assert.ok(p.usd > 0);
});
