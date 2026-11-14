// A minimal agent loop for the env-shell-tasks suite: one tool, run_command,
// executed on the host shell, against any OpenAI-compatible chat endpoint.
// The model and the shell are injected (`chat`, `exec`) so the unit tests run
// the whole loop with a scripted model and a fake shell.
import { spawn } from "node:child_process";
import { buildArm, hintFor, preflight, TOOL } from "./arms.mjs";
import {
  classifyOutcome,
  familyFlips,
  isTranslationRetry,
  repeatedFailures,
} from "./classify.mjs";
import { prepare } from "./tasks.mjs";

export const MAX_OUTPUT = 4000;
export const COMMAND_TIMEOUT_MS = 20000;

/** argv for a shell: how a command string is handed to it. */
export function shellArgv(shell, command, { bashPath = "bash" } = {}) {
  switch (shell) {
    case "powershell":
      return {
        file: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
      };
    case "pwsh":
      return {
        file: "pwsh",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      };
    case "cmd":
      return {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", command],
        verbatim: true,
      };
    case "bash":
      return { file: bashPath, args: ["-c", command] };
    case "wsl":
      return { file: "wsl.exe", args: ["--", "bash", "-lc", command] };
    default:
      throw new Error(`unknown shell ${shell}`);
  }
}

const clip = (s) =>
  s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]`
    : s;

/** Run one command on a host shell. Resolves { exitCode, stdout, stderr, timedOut }. */
export function execOnHost(
  shell,
  command,
  { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS, bashPath } = {},
) {
  const { file, args, verbatim } = shellArgv(shell, command, { bashPath });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: Boolean(verbatim),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid)
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        stdout: clip(out),
        stderr: `${e.message}`,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : (code ?? 1),
        stdout: clip(out),
        stderr: clip(err),
        timedOut,
      });
    });
  });
}

/** One chat-completions request. Returns { message, usage }. */
export async function chatOpenAI({
  baseUrl,
  model,
  messages,
  tools,
  temperature,
  seed,
  maxTokens = 2048,
  timeoutMs = 300000,
  extra = {},
}) {
  const body = {
    model,
    messages,
    tools,
    tool_choice: "auto",
    max_tokens: maxTokens,
    stream: false,
    ...extra,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (seed !== undefined) body.seed = seed;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const message = j.choices?.[0]?.message ?? {};
  return {
    message,
    usage: {
      promptTokens: j.usage?.prompt_tokens ?? 0,
      completionTokens: j.usage?.completion_tokens ?? 0,
      cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

/** The command in a tool call, whatever shape the endpoint returned. */
export function commandOf(call) {
  try {
    const a = call.function?.arguments;
    const o = typeof a === "string" ? JSON.parse(a) : (a ?? {});
    return typeof o.command === "string" ? o.command : null;
  } catch {
    return null;
  }
}

/** The tool result text the model sees. */
export function resultText(res, hint) {
  const parts = [
    `exit code: ${res.timedOut ? "timeout (stopped after the time limit)" : res.exitCode}`,
  ];
  if (res.stdout) parts.push(res.stdout);
  if (res.stderr) parts.push(`stderr:\n${res.stderr}`);
  if (hint) parts.push(hint);
  return parts.join("\n");
}

/**
 * Play one task in one arm. Returns the run record: pass, reasons, per-step
 * classification, and the counters the report reads. `chat(request)` and
 * `exec(shell, command, opts)` are injected; `dir` is the task directory.
 */
export async function runTask({
  task,
  armId,
  host,
  dir,
  token,
  chat,
  exec = execOnHost,
  maxTurns = 8,
  model,
  execOpts = {},
}) {
  const arm = buildArm(armId, host, dir);
  const ctx = prepare(task, dir, { token, shell: arm.shell });
  const env = task.env?.(ctx) ?? {};
  const messages = [
    { role: "system", content: arm.system },
    { role: "user", content: task.prompt(ctx) },
  ];
  const tools = [TOOL(arm.toolDescription)];
  const steps = [];
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  let finish = "max-turns";
  let error = null;
  let turns = 0;
  for (; turns < maxTurns;) {
    let r;
    try {
      r = await chat({ model, messages, tools });
    } catch (e) {
      finish = "error";
      error = String(e.message ?? e).slice(0, 200);
      break;
    }
    turns++;
    usage.promptTokens += r.usage.promptTokens;
    usage.completionTokens += r.usage.completionTokens;
    usage.cachedTokens += r.usage.cachedTokens ?? 0;
    const calls = r.message.tool_calls ?? [];
    messages.push({
      role: "assistant",
      content: r.message.content ?? null,
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    if (calls.length === 0) {
      finish = "done";
      break;
    }
    for (const call of calls) {
      const command = commandOf(call);
      if (command == null) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "error: run_command needs a string argument `command`",
        });
        steps.push({
          command: "",
          failed: true,
          cls: "other",
          evidence: "bad tool call",
          rejected: false,
        });
        continue;
      }
      const pre = arm.preflightOn ? preflight(command, arm.shell) : null;
      if (pre) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: pre.text,
        });
        steps.push({
          command,
          failed: true,
          cls: dialectClassOfCode(pre.code),
          evidence: `pre-flight ${pre.code}`,
          rejected: true,
          signals: [pre.code],
        });
        continue;
      }
      const res = await exec(arm.shell, command, {
        cwd: dir,
        env,
        ...execOpts,
      });
      const out = classifyOutcome({ command, shell: arm.shell, ...res });
      const hint = arm.hintOn ? hintFor(out, arm.shell) : null;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultText(res, hint),
      });
      steps.push({
        command,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        failed: out.failed,
        cls: out.cls,
        evidence: out.evidence,
        silent: Boolean(out.silent),
        signals: out.signals.map((s) => s.code),
        hinted: Boolean(hint),
        rejected: false,
      });
    }
  }
  const check = task.check(ctx);
  task.cleanup?.(ctx);
  const failedSteps = steps.filter((s) => s.failed);
  const translationRetries = steps.reduce(
    (n, s, i) =>
      n + (i > 0 && isTranslationRetry(steps[i - 1], s, arm.shell) ? 1 : 0),
    0,
  );
  return {
    task: task.id,
    arm: armId,
    shell: arm.shell,
    guidanceSha: arm.guidanceSha,
    pass: check.pass && finish !== "error",
    reasons: check.reasons,
    encoding: check.encoding,
    finish,
    error,
    turns,
    commands: steps.length,
    minCommands: task.minCommands,
    extraCommands: Math.max(0, steps.length - task.minCommands),
    firstTryFailed: steps.length > 0 ? steps[0].failed : null,
    failedCommands: failedSteps.length,
    classes: Object.fromEntries(
      [...new Set(failedSteps.map((s) => s.cls))].map((c) => [
        c,
        failedSteps.filter((s) => s.cls === c).length,
      ]),
    ),
    rejected: steps.filter((s) => s.rejected).length,
    hinted: steps.filter((s) => s.hinted).length,
    translationRetries,
    familyFlips: familyFlips(steps.map((s) => s.command)),
    repeatedFailures: repeatedFailures(steps),
    silentForeign: steps.filter((s) => s.silent).length,
    usage,
    steps,
  };
}

function dialectClassOfCode(code) {
  // pre-flight rejects are certain signals; map the code range to its class
  const n = Number(code.slice(1));
  if (n < 20) return "parse-bashism";
  if (n < 30) return "env-form";
  if (n < 40) return "path-form";
  if (n < 50) return "alias-flags";
  if (n < 60) return "tool-missing";
  return "foreign-syntax";
}
