# Security policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Use GitHub's [Private Security Advisories](https://github.com/Bantarus/claude-snaps/security/advisories/new)
to report. This keeps the report private until a fix is published and
gives us a coordinated-disclosure channel.

What helps us triage quickly:

- A short summary of the impact and the affected component
  (`@harness/core`, `@harness/cli`, `@harness/hook`, the format spec,
  or the Claude Code plugin under `plugin/`).
- The version or commit SHA you tested against.
- A minimal reproduction — input payload, command, or `.harness/`
  state that triggers the issue.
- Any environment specifics (Node version, OS, Claude Code version).

We aim to acknowledge new reports within **5 business days** and to
ship a fix or mitigation guidance before public disclosure. As this
project is **pre-1.0 and labeled experimental** (see the warning in
[README.md](README.md)), there is no LTS branch — fixes land on `main`
and are tagged in the next release.

## Scope

In-scope:

- The `harness` CLI and `harness-hook` binary — anything that writes
  to `.harness/`, mutates `.claude/settings.json`, executes against
  user-supplied paths, or processes Claude Code hook stdin.
- The reference reader/writer/index in `@harness/core`.
- The Claude Code plugin under [`plugin/`](plugin/) — its hooks,
  slash commands, and skill files.
- The `.harness/` format spec under [`spec/`](spec/) — issues where
  the spec mandates or permits unsafe behavior.

Out of scope:

- Vulnerabilities in upstream dependencies (Node, Claude Code, APM,
  SQLite). Report those to their respective projects; we will track
  pin/upgrade work in this repo once a fix is available upstream.
- Issues that require an attacker to already have write access to the
  user's `.harness/`, `.claude/`, or local filesystem — those are
  threat-model boundaries, not vulnerabilities.

## Hardening notes

Things to keep in mind when running the tool:

- **`harness install-hook`** mutates `.claude/settings.json`. It always
  writes a `.bak` and asks for interactive confirmation; review the
  diff before approving.
- **`harness-hook`** runs on every `SessionStart` / `UserPromptSubmit`
  event Claude Code emits. It exits `0` on any internal failure by
  design (so a hook bug never blocks the user's session). If you need
  defensive isolation, run Claude Code from a workspace where the hook
  is not installed.
- **Hook payloads** are the only data the hook trusts from Claude
  Code; treat them as adversarial input if you fork the implementation.
  The current code validates and clamps where it can; see
  [`spec/hooks.md`](spec/hooks.md) §1 for the parsed surface.

## Supported versions

Only the latest tagged release on `main` receives fixes. There is no
back-porting policy while the project is pre-1.0.
