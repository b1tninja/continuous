## Behaviour changes

- **Allow rules read a terminal command the way its shell does.** An allow rule no longer covers text that its shell reads as more commands than the rule sees: a lone carriage return, bash's `$'...'`, or a comment followed by another line, in every shell. In PowerShell and cmd the shell's own reading must also be understood, and each command it finds must be covered by an allow rule. In PowerShell this means an allow rule no longer covers a command holding `$`, `(`, `{`, `#`, `!`, `@`, a backtick, `&&` or `||`, or a redirect other than to `$null`: such a command follows your level instead (headless, one that would ask is refused). `cn`'s `Bash(...)` allows get the same check. Deny and ask rules are unchanged.
- PowerShell's curly quotes, en and em dashes and Unicode spaces: a PowerShell command holding one is no longer vouched read-only, and deny rules, ask rules and protected paths also meet its ASCII spelling (`git “push”` is `git push` there). `Get-Process -ComputerName` is no longer vouched as a local read, because it asks another machine.

## Fixes

- Protected paths recognise Windows 8.3 short names with punctuation or a number past 9 (`GIT-CR~1` for `.git-credentials`, `VAULT-~1`, `GIT-C~10`).
- An "Auto-answered: question -> answer" line stays one line when the answer holds a line break.
