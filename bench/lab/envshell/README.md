# env-shell-tasks

Does telling the agent about its host (operating system, shell, WSL) and correcting it after a bad command reduce failed commands? This suite measures that, per model, cheaply. The design, statistics and costed plans are in `plans/research/env-disclosure-evaluation.md`; this folder is the dev-only harness. Nothing in `core/`, `gui/`, `extensions/`, `binary/` or `packages/` imports it, and it ships in no release.

Plain Node ESM (Node 22.13 or newer), no dependencies beyond the lab's own `lib/`. Run it through the lab CLI:

```sh
node bench/lab/lab.mjs envshell help
```

## What is in the box

| File                       | What it is                                                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.mjs`                | 13 tasks `ES01` to `ES13`: create files, chain, read env, JSON with quotes, run a script, git in a temp repo, pipes, list and grep, paths, background process, nested quoting, line endings, exit code. Each has a setup, a prompt that names no shell, and a deterministic checker |
| `checkers.mjs`             | Pure checkers: exact text, JSON, byte order mark, UTF-16, CRLF, host path forms (`C:\x`, `/c/x`, `/mnt/c/x`, `/tmp/x` under Git Bash)                                                                                                                                               |
| `classify.mjs`             | The failure taxonomy and the dialect (bash-ism) detector: `dialectSignals`, `classifyOutcome`, translation retries, family flips                                                                                                                                                    |
| `arms.mjs`                 | The arms `A0` to `A7`: what the model is told and what the harness does after a failure. **The A3 guidance text is a placeholder**, not the product text                                                                                                                            |
| `agent.mjs`                | A one-tool agent loop against any OpenAI-compatible endpoint, and the shell executor (PowerShell 5.1, pwsh, cmd, bash, WSL)                                                                                                                                                         |
| `solutions.mjs`            | Reference solutions per shell (never shown to a model) and naive bash commands, for `selftest`                                                                                                                                                                                      |
| `replay.mjs`, `oracle.mjs` | Offline replay of recorded commands, and the detector measured against the shells' own parsers                                                                                                                                                                                      |
| `report.mjs`               | The scorecard, paired McNemar and bootstrap against a baseline arm, and exact paired power                                                                                                                                                                                          |
| `fixtures/`                | `commands-synthetic.json`: 144 hand-written commands (not recorded output) for the oracle                                                                                                                                                                                           |

Tests are `bench/lab/test/envshell.test.mjs` (`cd bench/lab && npm test`).

## The arms

| Arm | The model is told                                                                                                    | The harness does                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A0  | nothing about the host                                                                                               | nothing                                                                        |
| A1  | what the CLI says today: `<env>` with `Platform:`, and a tool sentence that already says PowerShell 5.1 and not `&&` | nothing                                                                        |
| A1i | the IDE terminal tool's sentence today (only `shell powershell.exe`, no `&&` warning)                                | nothing                                                                        |
| A2  | one line: OS and shell                                                                                               | nothing                                                                        |
| A3  | the guidance block for the shell (placeholder text)                                                                  | nothing                                                                        |
| A4  | A3                                                                                                                   | appends a corrective hint to the result of a failed command                    |
| A5  | A3                                                                                                                   | does not run a command the shell's parser cannot read; returns the reject text |
| A6  | the guidance block for bash in WSL                                                                                   | runs commands in WSL (`wsl.exe -- bash -lc`)                                   |
| A7  | the guidance block for the WRONG shell (control)                                                                     | nothing                                                                        |

A1 is copied from `extensions/cli/src/systemMessage.ts` and `extensions/cli/src/tools/runTerminalCommand.ts` (`describeShell`) as read on 2026-11-12; `A1i` is the IDE tool sentence (`core/tools/definitions/runTerminalCommand.ts`, before #765). If either changes, update `cliText` and `ideText` in `arms.mjs`. The `guidanceSha` in every record says which guidance text was used, so a later edit of the placeholder does not silently mix with old results.

## Failure taxonomy

`parse-bashism`, `env-form`, `path-form`, `alias-flags`, `tool-missing`, `foreign-syntax` (the six "written for the wrong shell" classes), `quoting`, `hang`, `other`. File-level corruption (`bom`, `utf16`, `crlf`) is found by the checker, not the command, because the command succeeded. `node bench/lab/lab.mjs envshell list` prints each with its meaning.

## Commands

All of these are free and send nothing unless they say `--run`.

```sh
# prove the tasks and checkers on this machine, no model (Windows PowerShell 5.1, then Git Bash)
node bench/lab/lab.mjs envshell selftest --shell powershell
node bench/lab/lab.mjs envshell selftest --shell bash --bash-path "C:/Program Files/Git/bin/bash.exe"

# classify recorded commands, no model and no shell
node bench/lab/lab.mjs envshell replay --input path/to/dumps-or-fixtures
node bench/lab/lab.mjs envshell oracle --shell powershell --input bench/lab/envshell/fixtures/commands-synthetic.json

# a dry plan with a cost estimate (list prices are per million tokens)
node bench/lab/lab.mjs envshell plan --models some-model --arms A0,A1,A2,A3,A4,A5 --reps 5 --price-in 2 --price-out 10
node bench/lab/lab.mjs envshell power
```

### The free local arm (Strata or any OpenAI-compatible server)

On the owner's machine Strata answers at `http://127.0.0.1:8080` with the model `qwen3.8-flash-next-nvfp4-nvfp4`; check with `curl http://127.0.0.1:8080/v1/models`. Do not stop or restart it for this. Write results outside the repository (the harness refuses a folder inside it):

```sh
# a small smoke: 8 runs, at most 20 requests (A0 and A3 on four tasks)
node bench/lab/lab.mjs envshell run --run --models qwen3.8-flash-next-nvfp4-nvfp4 \
  --arms A0,A3 --tasks ES02,ES03,ES05,ES11 --reps 1 --max-requests 20 --out D:/temp/env-eval/smoke1
node bench/lab/lab.mjs envshell report D:/temp/env-eval/smoke1

# the full free run: 6 arms x 13 tasks x 5 reps = 390 runs, about 1400 requests, a few hours; resumable (a rerun skips what is done)
node bench/lab/lab.mjs envshell run --run --models qwen3.8-flash-next-nvfp4-nvfp4 \
  --arms A0,A1,A2,A3,A4,A5 --reps 5 --max-requests 2000 --out D:/temp/env-eval/strata-full
```

`--seed N` gives rep `r` the seed `N + r - 1`; `--temperature` defaults to 0.6 so reps differ. `--extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'` is merged into every request when a server needs it.

### Paid models

`--api` is OpenAI chat completions only in this change. A first-party Anthropic run needs a Messages adapter (ROADMAP row EV88) and the owner's word per run; the harness never reads a key. Any OpenAI-compatible gateway the owner already uses works today through `--base-url`.

## What a record holds

One JSON line per run in `envshell.jsonl`: model, arm, task, rep, seed, `pass` and the checker's `reasons`, `encoding`, `finish`, turns, commands, `firstTryFailed`, failed commands and their classes, `translationRetries`, `familyFlips`, `repeatedFailures`, `silentForeign` (commands that ran with a foreign-dialect signal and no error), token usage, and every step (command, exit code, class, evidence, signals).

## Limits

- The detector is a bench-side reader, independent of the product's `detectShell.ts` and `commandLint.ts`; agreement between the two is a ROADMAP row, not claimed here.
- Commands run with `-NoProfile` on PowerShell; the product does not, so a profile that changes `PATH` or aliases is not modelled.
- Each task directory is under `--out`; a task that starts a process (ES10) is cleaned up by its pid file, but a model that spawns something else is not caught.
- 20 s per command, then the process tree is killed and the step is class `hang`.
- Absolute-path tasks resolve Git Bash's `/tmp` to the Windows temp folder; any other MSYS mount is read as it is.
