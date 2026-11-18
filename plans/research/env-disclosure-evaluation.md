# Environment disclosure: how to measure whether it reduces failed commands

Research and design report, 2026-11-12. Code read on `origin/main` at `ee644eb`. `plans/ROADMAP.md` is not edited: section 10 holds the proposed rows. Releases use even minors: 2.16.0 is being cut, so "2.18.0 candidate" means the release after it. The dev-only harness this report describes is the draft pull request #766 (`bench/lab/envshell/`); nothing in it ships.

Convention: "measured" means run on the review machine (Windows 11, Windows PowerShell 5.1.26100, Git for Windows bash, node 25.9, git 2.54; WSL installed but not started). "Verified by test" means a test in #766 was written and run. "From the pricing page" means read on 2026-11-12 at `platform.claude.com/docs/en/about-claude/pricing`. "Unverified" means from memory or a source I could not open.

## 1. Summary

1. **The question is measurable cheaply.** A suite of 13 small tasks with byte-exact checkers (`ES01` to `ES13`) plays a one-tool agent against any OpenAI-compatible endpoint, classifies every failed command into nine classes, and compares arms pairwise on the same (task, rep) pairs. Against the local model on this machine it costs nothing; a 390-run arm grid on Claude Sonnet 5.5 is about USD 5 at list prices (section 6.2).
2. **A first smoke already shows the effect we expect.** Qwen3.8 on the local Strata server, told nothing about its host (arm A0), wrote a bash command first in **4 of 4** tasks on Windows PowerShell 5.1 and every one failed to parse; with the guidance block (A3) the one task run needed no retry. That is 20 requests, not a result: n=4 and n=1 (section 7.4).
3. **The product already tells the CLI model more than the plan assumed.** The CLI's terminal tool description says "Runs in Windows PowerShell 5.1 ... chain commands with ; or a newline, not &&". The IDE tool says only "shell powershell.exe" (#765 changes that). So the comparison that matters is not A0 against the new block but **A1 (today's CLI text) against A3 (the block)**, and the IDE's A1i against both (section 3).
4. **Two things the review machine measured change the guidance text.** `grep`, `sed`, `awk`, `head`, `tail`, `wc`, `touch`, `find` and `which` all resolve in PowerShell 5.1 here, because Git for Windows' `usr\bin` is on `PATH`; telling the model "there is no grep" would be false on a developer machine. And `mkdir -p` and `cp -r` work in 5.1 while `ls -la`, `rm -rf`, `cat -n`, `sort -r`, `echo -e`, `mv -f`, `ps aux` and `curl -s` fail (section 7.3).
5. **The failure that costs most is often silent, not loud.** `echo $TASK_TOKEN > token.txt` in 5.1 exits 0 and writes an empty UTF-16 file; `> file` and `Out-File` write UTF-16 with a byte order mark, and `Set-Content -Encoding UTF8` writes a UTF-8 byte order mark (all measured, section 7.3). The checkers read bytes for that reason, and the suite counts these as `silentForeign` and file-level encoding failures, not as failed commands.
6. **The bash-ism detector, measured against PowerShell 5.1's own parser, has 100 percent precision and 96 percent recall on its parse-level signals** (144 hand-written commands, 24 rejected by the parser, 23 caught, 0 false alarms; 63 repository commands: 5 of 6). Its non-parse signals (Unix flags, missing tools) cannot be checked by a parser and are labelled hints (section 7.2).
7. **There is no recorded corpus of failing agent commands in the repository or under `D:\temp`** (searched; section 7.1). The offline replay therefore ran on 60 reviewer-set commands and 15 recorded model tool calls, which describe those corpora and say nothing about the wild. Recording real commands is row EV88.
8. **Recommended scope:** land #766 and run the free Strata grid (EV82) for 2.16.0 or right after; hold every paid run for the owner's word. Approvals asked in section 11, with estimates.

## 2. What exists

| Piece                                                                                    | Where                                                                                              | Used here as                                                                           |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Lab statistics: Wilson, exact McNemar, cluster bootstrap, effective n, power tables      | `bench/lab/lib/stats.mjs`, `compare.mjs`, `tools/power.mjs`                                        | reused by `envshell/report.mjs`, not copied                                            |
| Runner and scenarios (24 scenario files, `cn serve`, `matrix.yaml` prices)               | `bench/runner.mjs`, `bench/scenarios/`                                                             | the route for full-CLI paid runs; this suite is the cheaper loop-level instrument      |
| Costed run plans and prices                                                              | `plans/research/area-benchmark-toolcall-styles.md` section 6                                       | price table re-checked below; plan format reused                                       |
| Shell-awareness decision and rows SH1 to SH10                                            | `plans/research/shell-awareness.md`, PRs #756 to #759                                              | the shell kinds (`powershell` is always 5.1, `wsl.exe -- bash -lc`) the executors copy |
| Product bash-in-PowerShell lint                                                          | `core/tools/permissions/commandLint.ts` (CL040 to CL045), `detectShell.ts`, `missingBinaryGate.ts` | the product's existing "pre-flight reject"; A5 is its measured counterpart             |
| Peer research: remote and other-shell facts #761, privacy and cache #764, detectors #763 | open pull requests                                                                                 | the Environment block v2 text is theirs; A3 is a placeholder until it lands            |

## 3. What the product says today

| Surface    | Text the model sees about the host                                                                                                                                                                                                                                             | Source (read 2026-11-12)                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| CLI system | `<env> Working directory, Is directory a git repo, Platform: win32 </env>`                                                                                                                                                                                                     | `extensions/cli/src/systemMessage.ts`                               |
| CLI tool   | "Runs in Windows PowerShell 5.1 (powershell.exe) on Windows: chain commands with ; or a newline, not &&, and use PowerShell cmdlets and syntax." (WSL: "bash as a login shell inside WSL ... a Windows drive appears as /mnt/c"; container: "use bash syntax and Linux paths") | `describeShell` in `extensions/cli/src/tools/runTerminalCommand.ts` |
| IDE tool   | "Choose terminal commands and scripts optimized for win32 and x64 and shell powershell.exe." Nothing about `&&`. #765 replaces it with the CLI's wording.                                                                                                                      | `core/tools/definitions/runTerminalCommand.ts`                      |

So there are three baselines, not one: A1i (IDE today), A1 (CLI today), and A0 (nothing, the control that says whether any of it matters). The harness copies both texts and a test pins their key phrases; a drift check against the product is row EV85.

## 4. The evaluation suite: `env-shell-tasks`

### 4.1 Tasks

Prompts name relative paths and never name a shell. Programs used (`node`, `git`) are the same on every host, so only the shell text differs. Every task has a setup, a checker over bytes and process state, and a reference solution per shell (`selftest` runs them: 13 of 13 pass on Windows PowerShell 5.1 and on Git Bash).

| Id   | Task                                                                      | Failure classes it can provoke           | Fewest commands |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------- | --------------- |
| ES01 | create folder `out` with `a.txt` = alpha, `b.txt` = beta                  | path-form, alias-flags, tool-missing     | 1               |
| ES02 | one command line chaining `mkdir build` then a file                       | parse-bashism                            | 1               |
| ES03 | write the value of the environment variable `TASK_TOKEN`                  | env-form                                 | 1               |
| ES04 | write a JSON file with escaped quotes; it must parse                      | quoting, encoding                        | 1               |
| ES05 | run `node sum.js 3 4 5`, save its output                                  | encoding (UTF-16), alias-flags           | 1               |
| ES06 | git: branch, append a line, commit with a quoted message                  | quoting, hang (an editor), parse-bashism | 2               |
| ES07 | pipe a CSV through sort and take the top three                            | alias-flags, tool-missing, parse-bashism | 1               |
| ES08 | list files under `src` containing TODO, relative, forward slashes, sorted | path-form, tool-missing, alias-flags     | 1               |
| ES09 | copy a file with spaces in its path; write the copy's absolute path       | path-form, quoting                       | 1               |
| ES10 | start a background process, count its output, stop it                     | hang                                     | 3               |
| ES11 | write `He said "it's fine" & left` with one `node -e`                     | quoting                                  | 1               |
| ES12 | replace a word in a file, keep LF, no byte order mark                     | encoding (CRLF, BOM)                     | 1               |
| ES13 | run a script that exits 3; write the exit status                          | env-form (`$LASTEXITCODE`), alias-flags  | 1               |

Checks read bytes. `checkText` tolerates a trailing CRLF except in ES12 (where CRLF is the point); it fails on UTF-16 and on a UTF-8 byte order mark. ES09 accepts `C:\x`, `C:/x`, Git Bash `/c/x` and `/tmp/x` and WSL `/mnt/c/x` for the path it asks for, after resolving short (8.3) names. ES10 fails if the ticker is still running after the run (the checker kills it either way).

A cheap design property: the reference solutions are the proof each task is solvable. Writing them found two real host traps the model will meet: in Git Bash the pid a Windows program writes cannot be killed with `kill` (MSYS pids differ; `taskkill //F //PID` works), and Git Bash's `/tmp` is the Windows temp folder.

### 4.2 Failure taxonomy

Per command, from its exit code, output and text (`classifyOutcome`). A failure is a nonzero exit, or PowerShell error records with exit 0, or a timeout.

| Class            | What happened                                                                                                                        | Example, measured on 5.1                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `parse-bashism`  | bash syntax the parser rejects: `&&`, `\|\|`, heredoc `<<`, `export`, `VAR=x cmd`, `[[ ]]`, trailing `&`, `<` redirect, `"$HOME:/x"` | `mkdir b && echo c`: "The token '&&' is not a valid statement separator"                  |
| `env-form`       | another shell's variable syntax: `$NAME`, `%NAME%`, `$env:X` in bash                                                                 | `echo $TASK_TOKEN > f` runs and writes nothing (silent)                                   |
| `path-form`      | `/c/..`, `/mnt/c/..`, `/tmp`, `/dev/null` in PowerShell; `C:\` in bash                                                               | `> /dev/null`: "Could not find a part of the path 'D:\dev\null'"                          |
| `alias-flags`    | an alias or function given Unix flags                                                                                                | `ls -la`, `rm -rf`, `cat -n`, `sort -r`, `echo -e`, `mv -f`, `ps aux`, `curl -s` all fail |
| `tool-missing`   | a program the host does not have                                                                                                     | `jq`; **not** `grep`/`sed` on a machine with Git for Windows on `PATH`                    |
| `foreign-syntax` | PowerShell or cmd text sent to bash                                                                                                  | `Get-ChildItem`: "command not found"                                                      |
| `quoting`        | unterminated or mangled quotes; 5.1 strips `"` inside a native argument                                                              | ES11 under `node -e`                                                                      |
| `hang`           | the command did not return in 20 s                                                                                                   | `git commit` without `-m`, a server in the foreground                                     |
| `other`          | a real program failure none of the above explains                                                                                    | a test run failing                                                                        |

File-level corruption (`utf16`, `bom`, `crlf`) is found by the checker, since the command succeeded. Three derived counters: a **translation retry** (a dialect-class failure followed by a different command without those signals), a **family flip** (consecutive non-neutral commands change between bash-like and PowerShell-like; two or more is **oscillation**, the hint-loop symptom), and a **repeated failure** (the same command again after it failed; wasted turns). **Wasted turns** are `commands - minCommands` per task.

A design decision: output patterns decide the class; the text's own signals decide only when the output says nothing and the signal is _certain_ (the shell's own parser rejects it). The first version let a non-certain signal override and called a failing `grep` (installed) "tool-missing"; measured against the real shell that was wrong, and the rule changed.

## 5. Arms

| Arm | The model is told                                                             | The harness does                                                       | Question it answers                                                                                 |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A0  | nothing about the host                                                        | nothing                                                                | floor: what does the model assume?                                                                  |
| A1i | the IDE sentence today                                                        | nothing                                                                | is the IDE text better than nothing?                                                                |
| A1  | the CLI's text today (`<env>` plus the tool sentence with "not &&")           | nothing                                                                | the real baseline for the CLI                                                                       |
| A2  | one line: OS and shell                                                        | nothing                                                                | is the cheapest disclosure enough?                                                                  |
| A3  | the guidance block for the shell (**placeholder** until Environment block v2) | nothing                                                                | what does the full block add over A1 and A2?                                                        |
| A4  | A3                                                                            | appends a corrective hint to a failed command's result                 | does a hint after the failure add anything, and does it oscillate?                                  |
| A5  | A3                                                                            | does not run a command the parser cannot read; returns the reject text | does a pre-flight reject beat letting it fail? (the product's CL040 does this today for PowerShell) |
| A6  | the block for bash in WSL                                                     | runs in `wsl.exe -- bash -lc`                                          | does the WSL preference change the failure mix?                                                     |
| A7  | the block for the **wrong** shell                                             | nothing                                                                | control: does the model read the block at all, and what does a stale block cost?                    |

The placeholder A3 text is in `bench/lab/envshell/arms.mjs`, per shell, with the measured facts of section 7.3 in it; its `guidanceSha` travels in every record. Replacing it with the real Environment block v2 changes one constant, and old records stay comparable by the sha. The hint texts (A4) and reject text (A5) are per class and per shell, one paragraph, naming the shell; a hint is sent only for a dialect class, `quoting` or `hang`, never for `other`.

Arm interactions the grid does not cover: block plus hint on a remote host, block text size against the cache (peer #764), and the block's effect on non-shell behaviour (it must not make the model over-use PowerShell for tasks node does). The last one is why ES05, ES11 and ES13 use programs that behave the same everywhere.

## 6. Metrics, statistics and the run plans

### 6.1 Metrics

Per (model, arm), over runs (task x rep), all in `envshell report`:

| Metric                         | Definition                                                                 | Role                              |
| ------------------------------ | -------------------------------------------------------------------------- | --------------------------------- |
| Task success                   | checker passes at the end                                                  | secondary: models recover         |
| **First command failed**       | the first command the model issued failed (rate over runs that issued one) | **primary**: disclosure acts here |
| Any command failed             | at least one failed command in the run                                     | secondary                         |
| Turns, extra commands          | model requests; commands beyond the task's minimum                         | efficiency                        |
| Tokens and USD per solved task | total tokens (and cost at given prices) divided by solved runs             | what the owner pays               |
| Translation retries per run    | dialect failures followed by a rewrite                                     | the cost of ignorance             |
| Oscillating runs               | two or more family flips                                                   | hint-loop rate (A4, A5)           |
| Rejected, hinted               | pre-flight rejects, hints sent                                             | intervention volume               |
| Failed commands by class       | counts per class                                                           | which class each arm removes      |

Intervals: Wilson 95 percent on rates. Comparison: every arm against a baseline arm on the same (task, rep) pairs; exact McNemar on discordant pairs; the interval for the rate difference is a bootstrap that **resamples whole tasks** (`clusterBootstrap`), because the reps of one task share its difficulty. Below 25 pairs the report says "screening", as `compare` does. Per-class analyses are descriptive.

### 6.2 Power and sample size

Exact power of the paired McNemar test at alpha 0.05 (`envshell power`; discordant fractions are the share of pairs where only one arm succeeded):

| Scenario (only A / only B)           | n=30 | n=60 | n=100 | n=150 | n=250 |
| ------------------------------------ | ---- | ---- | ----- | ----- | ----- |
| difference 0.10 (0.04 / 0.14)        | 0.10 | 0.34 | 0.60  | 0.80  | 0.96  |
| difference 0.15 (0.05 / 0.20)        | 0.24 | 0.58 | 0.84  | 0.96  | 1.00  |
| difference 0.20 (0.05 / 0.25)        | 0.40 | 0.80 | 0.96  | 1.00  | 1.00  |
| difference 0.30 (0.05 / 0.35)        | 0.71 | 0.97 | 1.00  | 1.00  | 1.00  |
| difference 0.10, noisy (0.15 / 0.25) | 0.08 | 0.17 | 0.30  | 0.45  | 0.68  |

13 tasks x 5 reps = 65 pairs per model per arm pair. Expected effects, with their basis:

- **First command failed, weak or local models (Qwen class):** large, 0.4 to 0.9 (smoke: 4 of 4 failed under A0). 65 pairs has power above 0.97.
- **First command failed, strong hosted models:** unknown; a plausible 0.10 to 0.20 (they usually know Windows hosts). 65 pairs has power 0.34 to 0.8: to see 0.10 at power 0.8 needs about 150 pairs, **12 reps**.
- **Task success:** small (0.05 to 0.15), because models retry; do not size the study on it.
- **A4 and A5 against A3:** the added effect is on top of A3 and smaller; plan for 0.10 and 12 reps, or call it exploratory.

Three caveats stated up front. The McNemar pairs are not independent (13 tasks): the table is an upper bound on power, the task-level bootstrap interval is the honest one, and a task-level sign test is the conservative check (a row, EV93). Temperature above 0 with a seed per rep is required for reps to differ; at temperature 0 the reps repeat. Hosted models drift: a verdict row (I38) carries the date.

### 6.3 Harness plan

**Free, local (Strata at `127.0.0.1:8080`, model `qwen3.8-flash-next-nvfp4-nvfp4`, RTX 5090).** Verified reachable on 2026-11-12 (`/v1/models` lists one model, `n_ctx` 524288). One model, one request at a time, no GPU contention with the lab's other engines as long as Strata is not stopped. Exact commands are in `bench/lab/envshell/README.md`:

```sh
node bench/lab/lab.mjs envshell selftest --shell powershell
node bench/lab/lab.mjs envshell run --run --models qwen3.8-flash-next-nvfp4-nvfp4 \
  --arms A0,A1i,A1,A2,A3,A4,A5 --reps 5 --max-requests 2500 --out D:/temp/env-eval/strata-full
node bench/lab/lab.mjs envshell report D:/temp/env-eval/strata-full
```

7 arms x 13 tasks x 5 reps = 455 runs, about 1,600 requests. Wall time **unmeasured**; the smoke ran 5 runs, but the clock was not read. A planning figure of 30 to 60 seconds per run (thinking tokens dominate; smoke runs averaged about 0.9k output tokens) gives 4 to 8 hours: run it overnight, resumable, one arm order randomised per rep. The harness does not randomise arm order yet (a row, EV93).

**Paid, costed.** Tokens per run from the smoke: input about 2.8k (2.2k to 4.2k) and output about 0.9k on a thinking local model; hosted models without extended thinking should be below that on output. The estimate uses **3.0k input and 0.6k output per run** and doubles it for the upper bound (retries, thinking, longer histories). One arm grid is 390 runs (6 arms x 13 tasks x 5 reps); the full 7-arm plan with A7 on one model adds about 20 percent.

Prices, per million tokens (input / output), from the pricing page read 2026-11-12: Claude Haiku 5.5 USD 0.10 / 0.50 (prompts up to 100k); Haiku 4.5 1.00 / 5.00; Sonnet 5.5 2.00 / 10.00; Opus 5.5 4.00 / 20.00. Others from `bench/matrix.yaml` and the area-benchmark report section 6.1: Nova 2 Lite 0.33 / 2.75, Qwen3-Coder 30B 0.15 / 0.60. Cached input is cheaper (Haiku 5.5 0.01, Sonnet 5.5 0.10); the figures ignore it, so they are upper bounds on that axis.

| Model (family)            | Per run (3.0k in, 0.6k out) | 390 runs: expected | 390 runs: upper bound (x2) | 12 reps = 936 runs, expected |
| ------------------------- | --------------------------- | ------------------ | -------------------------- | ---------------------------- |
| Claude Haiku 5.5          | USD 0.0006                  | USD 0.23           | USD 0.5                    | USD 0.6                      |
| Claude Haiku 4.5          | USD 0.0060                  | USD 2.34           | USD 4.7                    | USD 5.6                      |
| Claude Sonnet 5.5         | USD 0.0120                  | USD 4.68           | USD 9.4                    | USD 11.2                     |
| Claude Opus 5.5           | USD 0.0240                  | USD 9.36           | USD 18.7                   | USD 22.5                     |
| Nova 2 Lite (Bedrock)     | USD 0.0026                  | USD 1.03           | USD 2.1                    | USD 2.5                      |
| Qwen3-Coder 30B (Bedrock) | USD 0.0008                  | USD 0.32           | USD 0.6                    | USD 0.8                      |
| Strata (local)            | 0                           | 0                  | 0                          | 0                            |

Recommended order, each step gated on the one before: (1) Strata grid (free); (2) Haiku 5.5 and Sonnet 5.5 at 5 reps, expected USD 4.9, upper bound USD 9.9; (3) only if (2) shows a first-command effect under 0.2, the 12-rep Sonnet 5.5 and Haiku 4.5 runs, expected USD 16.8; (4) Opus 5.5 and a Bedrock model only on request. Steps 2 and 3 expected about USD 22 together, about USD 44 at the upper bounds. Claude runs need the Messages adapter (row EV84); until it exists the paid arms go through an OpenAI-compatible gateway the owner already uses, or not at all. No key is read by the harness today, and no paid call was made for this report.

## 7. Evidence gathered without a model call

### 7.1 Is there a recorded corpus of failing commands?

Searched: `bench/` (`evidence/` holds the reviewer re-measure and Bedrock stream records; no terminal commands), the dialect corpus (`core/llm/toolDialects/corpus/fixtures`, 335 files, 18 with a `command` field), the permission corpora (`reviewer-starter.json`, 60 terminal commands), `D:\temp` (74,988 entries; no bench result folders; 36,136 `continue-cli-test-*` folders whose `cn.log` files hold no command lines). **No recorded corpus of failing agent commands exists.** I did not open the owner's Claude Code session transcripts under the user profile (211 files, 5.2 GB): they are private, outside what the task named, and a question for the owner (section 11, question 5).

What the replay ran on:

| Corpus                                                | Unique commands | Nature                                                                   |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `reviewer-starter.json` terminal rows                 | 59              | written by people to test the reviewer; mostly bash                      |
| dialect fixtures with a `command`                     | 5               | recorded model tool calls (15 calls, 5 distinct)                         |
| `bench/lab/envshell/fixtures/commands-synthetic.json` | 144             | hand-written by the author of #766 to span the classes; **not recorded** |

### 7.2 The classifier measured against the real parsers

Command: `envshell oracle`. The oracle asks Windows PowerShell 5.1 (`[System.Management.Automation.Language.Parser]::ParseInput`) or `bash -n` whether a command parses, never runs it, and compares with the detector's **certain** signals (the ones that claim "the parser rejects this").

| Set                       | Unique | Parser rejects | True positive | False positive | Missed | Precision [Wilson 95%] | Recall |
| ------------------------- | ------ | -------------- | ------------- | -------------- | ------ | ---------------------- | ------ |
| synthetic, PowerShell 5.1 | 144    | 24             | 23            | 0              | 1      | 100% [86%, 100%]       | 96%    |
| repository corpora, 5.1   | 63     | 6              | 5             | 0              | 1      | 100% [57%, 100%]       | 83%    |

The misses are `if exist build rmdir /s /q build` (cmd syntax) and `env | curl -d @- ...` (`@` splatting). The false-positive rate of the certain signals is 0 of 120 non-rejected synthetic commands (95 percent upper bound 3 percent). The first version had real false positives found by this procedure: `echo done` matched "done" as a loop end, and `$env:X` in bash was called certain (it runs, expanding to nothing). Both fixed; the oracle is now a regression check.

For bash the oracle is weak by nature: bash parses PowerShell text and fails at run time ("command not found"), so no signal for the bash host is certain, and the report treats them as hints.

**What a parser cannot check** is the non-certain signals: Unix flags on aliases and missing tools. Their ground truth is the shell's run-time behaviour, so section 7.3 measured it directly.

### 7.3 Measured behaviour of Windows PowerShell 5.1 on the review machine

Run with the harness's own executor in an empty temp folder (no destructive command; `-NoProfile`).

| Command                                                                                                           | Result                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `mkdir -p x/y`, `cp -r a b`, `rm -r x`                                                                            | work (exit 0)                                               |
| `ls -la`, `ls -l`, `rm -rf`, `cat -n`, `sort -r`, `echo -e`, `mv -f`, `ps aux`, `curl -s URL`                     | fail with a parameter error (exit 1)                        |
| `grep`, `sed`, `awk`, `head`, `tail`, `wc`, `touch`, `find`, `which`, `xargs`, `tr`, `cut`, `tar`, `file`, `stat` | resolve as applications (Git for Windows `usr\bin` on PATH) |
| `jq`, `rg`, `zip`, `fd`                                                                                           | not found                                                   |
| `tee`, `diff`, `curl`, `sort`, `ls`, `cat`, `rm`, `cp`, `ps`, `kill`, `echo`                                      | PowerShell aliases (`curl` is `Invoke-WebRequest`)          |
| `'x' > f`, `Out-File`                                                                                             | UTF-16 LE with BOM `ff fe`, CRLF                            |
| `Set-Content -Encoding UTF8`                                                                                      | UTF-8 **with** BOM `ef bb bf`, CRLF                         |
| `Set-Content` (default)                                                                                           | no BOM, CRLF                                                |
| `[IO.File]::WriteAllText`                                                                                         | no BOM, no CRLF added                                       |
| `echo $TASK_TOKEN > token.txt`                                                                                    | exit 0; the file holds an empty UTF-16 string               |
| `node -e "...\"..."` with embedded `"`                                                                            | the quotes are stripped before node sees the text           |

Consequences for the guidance: do not say "there is no grep" (say "may not be installed: check with `Get-Command`"); the encoding advice (`[System.IO.File]::WriteAllText`, or node) is the one that fixes ES05 and ES12 and avoids a BOM; `mkdir -p` need not be warned about. The placeholder A3 text is written to these measurements. This machine is one sample: a machine without Git on `PATH` differs, which is itself a reason the suite reports `tool-missing` per host and the block should be built from detected facts, not constants (peer #763).

### 7.4 Offline replay: how often each class appears in the corpora

`envshell replay` classifies the text of each command for a target shell, no model, no shell. These describe the corpora, not the wild.

| Corpus, target PowerShell 5.1     | Unique | Any foreign signal | Certain signal | alias-flags | tool-missing | parse-bashism | path-form | env-form | foreign |
| --------------------------------- | ------ | ------------------ | -------------- | ----------- | ------------ | ------------- | --------- | -------- | ------- |
| reviewer-starter (people)         | 59     | 22 (37%)           | 5 (8.5%)       | 11          | 6            | 5             | 1         | 0        | 0       |
| dialect fixtures (recorded model) | 5      | 2 (40%)            | 0              | 1           | 1            | 0             | 0         | 0        | 0       |
| synthetic (author's spread)       | 144    | 67 (47%)           | 23 (16%)       | 12          | 30           | 24            | 5         | 3        | 3       |

Read: when a command written by a bash-trained author is read by 5.1, about a third carry something the host would not take, and about 9 percent would not parse at all. That is the opportunity size for disclosure, and the reason the first-command rate (not the success rate) is the primary metric. The corpus gap is real: the recorded fixtures are 5 commands.

### 7.5 The free smoke (20 requests, local model, results under `D:\temp\env-eval\smoke1`)

Qwen3.8 on Strata, Windows PowerShell 5.1, temperature 0.6, tasks ES02, ES03, ES05, ES11:

| Arm | Runs | Solved | First command failed | Failed commands by class                       | Turns (median) | Tokens in / out per run (mean) |
| --- | ---- | ------ | -------------------- | ---------------------------------------------- | -------------- | ------------------------------ |
| A0  | 4    | 3      | 4 of 4               | parse-bashism 4 (`&&`, `2>/dev/null`), other 1 | 4              | 2.9k / 1.0k                    |
| A3  | 1    | 1      | 0 of 1               | none                                           | 3              | 2.5k / 0.5k                    |

The request cap stopped the run before more A3 tasks. Every A0 run opened with a bash chain or `$VAR` and recovered by switching to PowerShell on the next turn (4 translation retries). The one A0 failure was a UTF-8 byte order mark from a PowerShell file write (ES05), which is a **recovery that introduced a different failure**: exactly the case the suite's byte checks exist for. n=4 and n=1: this is a demonstration that the instrument works, not an estimate.

## 8. Additional research: the largest remaining uncertainties

1. **Are the power assumptions sound?** Measured partly: the only observed effect is a first-command failure of 4 of 4 under A0 for a local model, which supports the large-effect row of the table for that family. For hosted strong models the effect size is **unknown**; section 6.2 sizes the study for 0.10 and shows what 5 reps cannot see. Resolve by running the free grid and one cheap hosted model (Haiku 5.5, USD 0.23 expected), then sizing the rest from the observed discordance. A second uncertainty found while measuring: McNemar over (task, rep) pairs overstates independence with 13 tasks; the bootstrap now resamples tasks, and a task-level sign test is a row (EV93).
2. **How do other benchmarks score shell tasks?** Only partly verified. InterCode frames interactive coding with Bash, SQL and Python environments, "code as actions and execution feedback as observations", built from NL2Bash, Spider and MBPP (arXiv abstract, read 2026-11-12). Terminal-Bench "runs in Harbor", inside containers or sandboxes, with repeated trials (`-k 5` in its documented command) (tbench.ai docs, read 2026-11-12). I could not open the pages that define their rewards and metrics, so the statements that InterCode-Bash scores by file-system state and output, and that Terminal-Bench tasks carry their own test scripts, are **unverified** and from memory. What this suite does differently, by design: it scores the command-level failure (the first command, the class, retries), not only the end state, because the question is about the cost of a wrong guess, and it runs on the host shell, not a Linux container, because the Windows case is the one the hosted benchmarks do not cover.
3. **What is the false-positive rate of the offline classifier on real commands?** Resolved for the parse-level signals (section 7.2): 0 of 120 on the synthetic set, 100 percent precision on both sets, from the shell's own parser. Not resolved for the Unix-flag and missing-tool signals, and not on commands an agent actually wrote: no recorded corpus exists. The classifier's `certain` flag is the safeguard: only certain signals may block a command (A5); the others only hint. Resolve with EV88 (record real commands) and EV161 (replay owner-approved transcripts).
4. **Local-model behaviour.** Measured on one model, 5 runs: it writes bash first on a Windows host when told nothing, recovers in one turn, and its recoveries carry their own traps (a BOM). Unmeasured: effect of thinking on or off (the smoke ran with the server's default), temperature, whether a hint causes oscillation (the smoke never reached A4), and behaviour on a Qwen-class model's text-dialect tool calls (the server returned native `tool_calls`; the harness would record a missing call as `finish: done` with zero commands). Resolve with the free grid and `--extra-body` to toggle thinking.
5. **Does the guidance text cost more than it saves?** The placeholder A3 block for PowerShell is about 330 tokens (1,302 characters at 4 per token; bash 65, WSL 96); at 3.0k input per run that is 11 percent. Sonnet 5.5 input at USD 2 per million makes 330 tokens USD 0.00066 uncached and USD 0.000033 cached (USD 0.10 per million). A wasted turn is one more request, about 3k input and 0.2k output, about USD 0.008 on Sonnet 5.5. So the block pays for itself uncached if it avoids one wasted turn in about 12 runs, and in about 240 runs when cached. This is arithmetic on list prices, not a measurement; the metric "tokens and USD per solved task" measures it.

## 9. Design decisions worth knowing

- **The harness is its own loop, not `cn serve`.** The runner (`bench/runner.mjs`) measures whole-product behaviour at USD 0.05 to 0.5 per run; this suite needs 400 to 1,000 short runs per model. A one-tool loop costs 3.5 requests a run. The full-CLI confirmation is a few `shell-write`-style scenarios on the runner, after the cheap loop has found an effect.
- **Tasks name no shell.** A prompt that says "in PowerShell" would test reading, not the model's assumption.
- **A5 is not a new idea; it is measured.** The product already rejects some bash-in-PowerShell commands before running them (`commandLint` CL040, CL041, CL042). A5 says what that is worth on top of the block, and which classes it must not block (only certain signals).
- **Detector independence.** The bench-side detector does not import `detectShell.ts`; agreement between the two is row EV86, so neither grades itself.

## 10. Proposed ROADMAP rows (exact text)

Ids use the prefix `EV`. The ranges EV81 to EV100 (section 10) and EV161 to EV170 (section 14) were assigned to this report; peers hold EV41 to EV60 and others. Not edited into `plans/ROADMAP.md`.

| ID   | Scope                                                                                                                                                                                                                                                                       | Depends on                    | State                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| EV81 | Land the env-shell-tasks harness: 13 tasks with byte checkers, failure classifier and detector, arms A0 to A7, loop over any OpenAI-compatible endpoint, replay, oracle, report (`bench/lab/envshell/`, dev-only)                                                           | none                          | Draft PR #766 (XS to merge); 2.18.0 candidate (dev-only, any release) |
| EV82 | Run the free grid on Strata: arms A0, A1i, A1, A2, A3, A4, A5, 13 tasks, 5 reps (455 runs, about 1,600 requests), results outside the repo; write the verdict row (I38 format) with intervals                                                                               | EV81, owner approves GPU time | Not started (S, hours of GPU); 2.18.0 candidate                       |
| EV83 | Replace the placeholder A3 guidance with the Environment block v2 text per shell when it lands; keep arm ids, change the sha                                                                                                                                                | EV81, peers' text             | Not started (XS); 2.18.0 candidate                                    |
| EV84 | Anthropic Messages transport for `envshell run` (`--api anthropic`): key read from the user-level environment variable by name at run time, never written or logged, hard cost cap, dry plan first                                                                          | EV81, I35, MR8                | Not started (S); later                                                |
| EV85 | Drift check: the harness's copies of the CLI and IDE sentences (`cliText`, `ideText`) against `describeShell` and `PLATFORM_INFO`, failing when the product text changes                                                                                                    | EV81                          | Not started (XS); 2.18.0 candidate                                    |
| EV86 | Agreement between the bench detector and the product's `detectShell.ts` and `commandLint.ts` on the synthetic and recorded sets, through `adapter.mjs`; list the disagreements as rows for one side or the other                                                            | EV81                          | Not started (S); later                                                |
| EV87 | Paid first step after EV82: Haiku 5.5 and Sonnet 5.5, 6 arms x 13 tasks x 5 reps (780 runs); expected USD 4.9, upper bound USD 9.9 at list prices; owner approves the spend                                                                                                 | EV82, EV84                    | Not started (XS to run); later                                        |
| EV88 | Record real commands: an opt-in `commands.jsonl` per bench run (command, shell, exit code, first 2 KB of output, model, arm), written outside the repo, so replay has real failing commands and `bench/evidence/` can hold a redacted set                                   | EV81                          | Not started (S); 2.18.0 candidate                                     |
| EV89 | Ship bars for A4 and A5 in the run plan before the run: oscillation under 5 percent of runs, no class the intervention makes worse, first-command effect over 0.10 with the lower bound above 0; no default changes on a screening verdict                                  | EV82                          | Not started (XS, document); 2.18.0 candidate                          |
| EV90 | WSL host arm A6: run the grid with `wsl.exe -- bash -lc` and the WSL block, ES09 and ES10 checked with `/mnt/c` forms; needs a WSL distribution on the run machine                                                                                                          | EV82                          | Not started (S); later                                                |
| EV91 | Git Bash as its own host (`bash-msys`): the `/tmp` and MSYS-pid traps found in the reference solutions become tasks and guidance lines; executor and classifier signals                                                                                                     | EV81                          | Not started (S); later                                                |
| EV92 | `pwsh` host and arm (`&&` works, UTF-8 default), to put numbers on the SH8 decision (stay on 5.1 or use `pwsh` when present)                                                                                                                                                | EV82, SH8                     | Not started (S); later                                                |
| EV93 | Harness statistics hardening: randomise arm order per rep, a task-level sign test beside McNemar, an effective-n line (as `lib/stats.mjs` does), held-out twin tasks ES14 to ES26 (differently worded, different seed files, hashed) for any verdict that decides a default | EV82                          | Not started (M); later                                                |
| EV94 | Opt-in, local-only counters of failed-command classes in the audit log so a person can run `envshell replay` on their own history; no upload, no content beyond the class and shell                                                                                         | EV88, DS7                     | Not started (M); later                                                |

## 11. Owner questions (spend approvals and decisions)

1. **Free Strata grid (EV82).** 455 runs, about 1,600 requests, about 4 to 8 hours of GPU time (unmeasured; planning figure), no Strata restart. Recommended, pending owner: approve, overnight, one model, arm order as built.
2. **First paid step (EV87), Haiku 5.5 and Sonnet 5.5, 780 runs.** Expected USD 4.9, upper bound USD 9.9 at list prices (section 6.3); needs EV84 or an OpenAI-compatible gateway. Recommended, pending owner: approve after EV82 shows a first-command effect; not before.
3. **Second paid step, 12 reps on Sonnet 5.5 and Haiku 4.5, 1,872 runs.** Expected USD 16.8, upper bound about USD 34. Recommended, pending owner: decide after question 2's numbers.
4. **Opus 5.5 and Bedrock models (Nova 2 Lite USD 1.0, Qwen3-Coder 30B USD 0.3 per 390 runs).** Recommended, pending owner: only Nova 2 Lite as the cheap non-Claude family; no Opus unless a result needs a stronger-model ceiling.
5. **The owner's Claude Code session transcripts (EV161).** They hold thousands of real PowerShell and bash commands with their errors and are the nearest thing to a recorded corpus. Recommended, pending owner: allow a local-only, aggregate-only pass (counts by class; no content leaves the machine, none is written to the repository); otherwise rely on EV88.
6. **Wording of the A3 text.** The placeholder is not product text. Recommended, pending owner: the peers' Environment block v2 replaces it before any paid run, so a paid result is not spent on a throwaway text.
7. **A5 and the shipped lint.** The product rejects some commands before they run. Recommended, pending owner: measure A5 only with certain signals, and treat any pre-flight reject that blocks a command the shell would have run as a defect, not a trade.
8. **Where results live.** Recommended, pending owner: `D:\temp\env-eval\` for raw runs; only a verdict row and the report travel in a pull request.

## 12. Not verified

- InterCode's and Terminal-Bench's reward definitions (section 8, item 2): their pages could not be read in full.
- Wall time of the free grid; token figures for hosted models (estimated from one local model's smoke).
- Behaviour on pwsh 7, cmd as an agent host, WSL (installed here, not started for this report), macOS and a machine without Git on `PATH`.
- Whether the product's `commandLint` and the bench detector agree (EV86); the product was read, not run.
- Any statement about a real person's commands: no recorded corpus was found, and the owner's transcripts were not read.

## 13. Further research topics (ranked)

Ranked by how much each would change a decision per unit of cost. Costs are estimates from section 6.3; "free" means the local server.

| Rank | Question                                                                                                                            | Why                                                                                                                             | Method                                                                                                                                        | Cost and time                                    | Blockers                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| 1    | In the wild, which failure classes do agent commands on Windows hit, and how often?                                                 | Every number here comes from a smoke and hand-written corpora; the opportunity size is unknown                                  | Replay the owner's own session transcripts locally, aggregate counts by class only (EV161); plus opt-in recording in bench runs (EV88)        | Free; an hour of work                            | Owner's permission (question 5)                |
| 2    | Does the guidance block beat the CLI's current sentence (A3 against A1), not just nothing (A0)?                                     | The CLI already says "not &&"; the block must earn its tokens over that                                                         | The free grid, then Haiku 5.5 and Sonnet 5.5 (EV82, EV87); first-command rate, paired                                                         | Free, then about USD 5 expected                  | EV83 (real block text); owner's spend word     |
| 3    | Which is better: a hint after the failure, an auto-rewrite, or a reject before it?                                                  | A4, A5 and a rewrite (`&&` to `;`) differ in turns, trust and risk of changing meaning                                          | Add arm A8 (harness rewrites a certain bash-ism and says so) to the grid; compare turns, oscillation, silent errors (EV169)                   | Free on Strata; one more arm, 65 runs            | EV82                                           |
| 4    | Does thinking on or off change the shell error rate, and does the block substitute for thinking?                                    | Thinking models may reason their way to PowerShell; cheap models cannot afford to                                               | `--extra-body` toggles thinking on the same tasks; 2 x 2 (block x thinking) at 12 reps on one model (EV164)                                   | Free; about 4 hours                              | The server must accept the toggle (unverified) |
| 5    | Does a long session forget the block (does the first-command rate rise at turn 30 or after compaction)?                             | Compaction and long loops drop early text; a hint cadence or a tail reminder may be needed                                      | Prepend a synthetic 30-turn neutral history to ES02 and ES03 and measure first-command failure by position, with and without the tail (EV165) | Free for local; about USD 2 on Haiku 4.5         | A history generator (S)                        |
| 6    | What does a wrong or stale block cost (A7) when the host differs from what the block says (remote window, WSL preference mismatch)? | #756 to #759 show the product can name the wrong machine's shell; the cost of that error is unmeasured                          | Grid arm A7 plus remote-mismatch tasks where the block names the local shell but commands run elsewhere (EV167)                               | Free; about 130 runs                             | A second host (WSL or a container)             |
| 7    | Is a code fix better than a prompt: set the executor's encoding so the common traps vanish?                                         | An output-encoding and default-file-encoding prelude could remove the BOM and UTF-16 class without any tokens                   | Arm A9 = A1 with an executor prelude; compare file-level encoding failures (EV168)                                                            | Free; 65 runs; needs a product design if it wins | A product decision (SH8's profile question)    |
| 8    | Do tool-call format and shell error rates interact (native tool calls against a text dialect)?                                      | A dialect that mangles quotes shows up as a `quoting` failure that no shell text fixes                                          | Run ES04 and ES11 under native and recovered text dialects on one family (EV163)                                                              | Free local                                       | The dialect rows (`--dialect`)                 |
| 9    | Mixed-shell repositories: the person is in PowerShell, the repository's scripts are bash; does the model call them correctly?       | Real repositories carry `.sh` files; the block says "PowerShell" and the model may refuse `bash script.sh` or run `./script.sh` | Tasks that run a bash script from a PowerShell host, with and without Git Bash on `PATH` (EV170)                                              | Free; 5 tasks x 5 reps x 4 arms                  | EV91                                           |
| 10   | Does the block change non-shell behaviour (over-use of PowerShell where node would do; refusing portable commands)?                 | A block that makes every task a cmdlet task trades one error for another                                                        | Compare solution style and cost per solved task between A0 and A3 on node-only tasks (ES05, ES11, ES13), count cmdlet use                     | Free; analysis only, from the grid               | EV82                                           |

## 14. Additional proposed ROADMAP rows (exact text)

Ids EV161 to EV170, as assigned for this follow-up. Not edited into `plans/ROADMAP.md`.

| ID    | Scope                                                                                                                                                                                                                                                        | Depends on             | State                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------- |
| EV161 | Local, aggregate-only replay of the owner's own agent session transcripts through `envshell replay` and the parser oracle: counts by failure class and shell, no command text written anywhere; the numbers go into the report as the first in-the-wild rate | EV81, owner permission | Not started (S); 2.18.0 candidate                                 |
| EV162 | Hint wording experiment: terse, class-specific, with a worked example, and none, on the same failing commands (arm A4 variants); metric: translation retries and oscillation                                                                                 | EV82                   | Not started (S); later                                            |
| EV163 | Dialect interaction: ES04 and ES11 under native tool calls and each recovered text dialect, per family, to separate quoting damage by the tool-call format from damage by the shell                                                                          | EV82, Q18              | Not started (S); later                                            |
| EV164 | Thinking on or off against block or none (2 x 2), 12 reps on the local model; first-command rate and tokens per solved task                                                                                                                                  | EV82                   | Not started (S); later                                            |
| EV165 | Long-session decay: a synthetic neutral history of 30 turns before the task, and after a compaction, with and without the tail reminder; first-command rate by position                                                                                      | EV82                   | Not started (M); later                                            |
| EV166 | Cache cost of the block: measured cached and uncached tokens for the block placed in the stable prefix against in the first user message, per provider that reports them; ties to the privacy and cache report (#764)                                        | EV82                   | Not started (S); later                                            |
| EV167 | Host-mismatch tasks: the block names the local shell, the commands run in WSL, a container or a remote host; measure the failure cost of a stale block (arm A7 on a second host)                                                                             | EV90                   | Not started (S); later                                            |
| EV168 | Executor prelude arm A9: set output encoding and default file encoding before every PowerShell command, so BOM and UTF-16 corruption disappears without prompt text; compare file-level encoding failures with the block alone                               | EV82, SH8              | Not started (S); a product decision follows; later                |
| EV169 | Auto-rewrite arm A8: the harness rewrites a certain bash-ism (`&&` to `;` with a check, `/dev/null` to `$null`) and tells the model what it did; the checker, not the model, finds silent semantic changes                                                   | EV82                   | Not started (S); security review of any product port first; later |
| EV170 | Mixed-shell repository tasks: a bash script run from a PowerShell host, with and without Git Bash on `PATH`; five tasks, checkers on output and exit status                                                                                                  | EV91                   | Not started (S); later                                            |
