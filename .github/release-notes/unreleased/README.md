# Unreleased release-note fragments

Each pull request adds its release notes as one file in this directory, named after its branch: `unreleased/<branch-name>.md`. A branch name with a `/` uses `-` in the file name (`claude/plan-files` becomes `claude-plan-files.md`). Because no two pull requests write the same file, merging one never conflicts another.

A fragment uses the same sections as `../UNRELEASED.md`, and only the ones it needs:

```markdown
## New

- One bullet per change, written for the person using the extension or `cn`.

## Behaviour changes

## Removed

## Fixes
```

Add bullets only under these headings. Do not edit another pull request's fragment or the entries in `UNRELEASED.md`.

## At release time

1. `node scripts/release-notes-fragments.mjs` prints the combined sections: the entries in `UNRELEASED.md` first, then every fragment in file-name order, grouped by section.
2. Fold that output into `.github/release-notes/v<version>-vscode.md` (the release job reads `.github/release-notes/<tag>.md`).
3. `node scripts/release-notes-fragments.mjs --clean` deletes the fragments (this README stays). Then delete `UNRELEASED.md`, or empty it back to its headings.
