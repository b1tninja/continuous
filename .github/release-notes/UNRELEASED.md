# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- In the `cn` command line, `Fetch` now asks before reading a URL that carries a long encoded value or credentials, and before reading a name that does not resolve and has no public top-level domain (`http://wiki.corp/`, `http://nas.lan/`), as the IDE does. Headless runs refuse these calls. Both checks were skipped at the default levels.
- A single-label name that does not resolve here, such as `http://wiki/` or `http://jenkins/`, now asks before a model fetch in the IDE and in `cn`, even when the label is also a public top-level domain (`.wiki`, `.app`). Behind a proxy such a name is usually an internal host.
