# Unreleased

Staging note for the next release. New entries go in `unreleased/<branch>.md` (see `unreleased/README.md`); this file keeps entries that were added before fragments. At release time, fold this file and every fragment into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`; `node scripts/release-notes-fragments.mjs` prints them combined), then delete this file and the fragments.

## New

## Behaviour changes

## Fixes

- In the `cn` command line, `Fetch` now asks before reading a URL that carries a long encoded value or credentials, and before reading a name that does not resolve and has no public top-level domain (`http://wiki.corp/`, `http://nas.lan/`), as the IDE does. Headless runs refuse these calls. Both checks were skipped at the default levels.
- A single-label name that does not resolve here, such as `http://wiki/` or `http://jenkins/`, now asks before a model fetch in the IDE and in `cn`, even when the label is also a public top-level domain (`.wiki`, `.app`). Behind a proxy such a name is usually an internal host.
