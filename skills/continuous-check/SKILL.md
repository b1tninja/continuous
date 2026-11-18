---
name: continuous-check
description: Run AI review agents on local code changes with the Continuous CLI (`continuous review`), and look up what else the CLI can do. Use when asked to "run checks", "review my changes with continuous", "lint with AI", or to check which CLI commands and flags are available.
license: Apache-2.0
metadata:
  author: b1tninja
  version: "2.0.0"
---

# continuous check: local AI review of your changes

Run AI review agents against your working tree with the `continuous` CLI. Each review is an agent defined in a markdown file. It reads your diff, reports what it finds, and may suggest fixes as a patch.

Adapted from the `cn-check` skill of Continue (https://github.com/continuedev/continue, Apache License 2.0). See the NOTICE file in the Continuous repository.

## When to use

- The user asks to run AI checks or a review on their changes.
- The user wants to write a review agent for a project.
- The user wants suggested fixes applied locally.
- The user asks what the CLI can do, or how to run it headless.

## Before you start

- The command is `continuous`; the short alias `cn` is equivalent. Examples here use `continuous`.
- `continuous --help` and `continuous <command> --help` list the commands and flags of the installed version. Prefer them over this page when they differ.
- The project must be a git repository with uncommitted changes or a branch that differs from its base.

## Run the reviews

```bash
continuous review
```

The agents come from, in order:

1. `--review-agents <paths...>`, when given.
2. Markdown files in `.continuous/agents/`, `.continue/agents/`, `.continuous/checks/` and `.continue/checks/` (the first file with a given name wins).

Options:

```
continuous review [options]

  --base <ref>                Git ref to diff against (default: auto-detect)
  --format <format>           Output format; json for scripts
  --fix                       Apply suggested patches to the working tree
  --patch                     Print the patches only, for git apply
  --fail-fast                 Stop on the first failure
  --review-agents <agents...> Specific agent files to run
  --verbose                   Debug logging
```

```bash
continuous review --base develop
continuous review --review-agents .continuous/agents/security.md
continuous review --format json
continuous review --patch | git apply
```

The command exits 0 when every review passes and 1 when any fails or errors. A review that runs longer than 5 minutes is stopped and reported as an error. With nothing to diff, it prints "No changes detected" and exits 0.

## Write a review agent

Create `.continuous/agents/<name>.md`:

```markdown
# Security Review

You are a security reviewer. Examine the code changes for:

- SQL injection
- Hardcoded secrets or credentials
- Use of eval() or similar

If you find issues, edit the files to fix them. If everything looks good, say so and stop.
```

Each review runs in its own temporary git worktree. Any edit the agent makes there is captured as a patch and the review is reported as "fail" with that patch. No edits means "pass".

## JSON output

`--format json` prints an object with a `reviews` array and a `summary`. Each review has `agent`, `name`, `status` (`pass`, `fail` or `error`), `patch`, `output`, `duration` in seconds, and `error` when it errored.

## Running the CLI headless

```bash
continuous -p "review my current git diff"
git diff | continuous -p "summarize this change"
continuous -p --config ./config.yaml "..."
```

- `-p` / `--print` prints the response and exits. `--format json` and `--silent` apply to it.
- `--max-turns <n>` stops after n model requests. `--max-budget-usd <n>` stops before a request that would pass the dollar cap; it needs a model with a known price unless `--budget-allow-unpriced` is given. `--max-duration <minutes>` stops after that long.
- `--allow <tool>`, `--ask <tool>` and `--exclude <tool>` (repeatable) override the permission policy for a tool. `--readonly` starts in plan mode, `--auto` allows all tools.

## Other commands worth knowing

| Command                                            | What it does                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `continuous doctor network [url...]`               | Diagnose proxy and certificate problems                                                              |
| `continuous secrets [scan] [paths...]`             | Scan files for secrets (values are never printed); exit 3 on a finding; `--staged` adds staged files |
| `continuous plan list`                             | List the plans Plan mode wrote to `.continuous/plans`                                                |
| `continuous plan build <name>`                     | Run the agent on a plan from its first unchecked to-do; `-p` for headless                            |
| `continuous clean`                                 | Delete old sessions, dev_data and logs; a dry run unless `--yes`                                     |
| `continuous permissions [list\|test\|add\|remove]` | Show or edit permission rules                                                                        |
| `continuous ls`                                    | List recent sessions to resume (`--resume` resumes the last one)                                     |

`continuous serve` starts an HTTP server with `/state` and `/message`. It listens on 127.0.0.1:8000 by default. A bearer token (`--token`, or the `CONTINUOUS_SERVE_TOKEN` variable, at least 16 characters) is optional on loopback and required with any other `--host`.

## Troubleshooting

| Problem                      | Solution                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| "No changes detected"        | Make changes, or pass `--base <ref>`                                                  |
| "No reviews found"           | Add `.md` files under `.continuous/agents/`, or pass `--review-agents`                |
| Review times out (5 minutes) | Reduce the diff or split the agent into narrower ones                                 |
| "Worker exited with code 1"  | Run with `--verbose` and check the log                                                |
| Patch conflicts with `--fix` | Apply by hand: `continuous review --patch > changes.patch && git apply changes.patch` |
| Requests fail behind a proxy | `continuous doctor network`                                                           |
