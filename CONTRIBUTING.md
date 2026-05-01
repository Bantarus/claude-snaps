# Contributing

This document covers the development setup. The format spec is at
[spec/](spec/), implementation in [packages/](packages/).

## Prerequisites

- **Node ≥ 24.0** — pinned in [.nvmrc](.nvmrc). Required for the
  built-in `node:sqlite` module the core layer uses.
- **pnpm ≥ 9** — workspace manager. `corepack enable` will install it.
- **POSIX shell with `env -S` support** (coreutils ≥ 8.30 — Linux,
  macOS Catalina+, BSD). Used in the bin shims for the
  `--no-warnings=ExperimentalWarning` flag.

## Bootstrap

```bash
nvm use                    # picks up .nvmrc → Node 24
corepack enable            # makes pnpm available
pnpm install               # workspace install, no native compilation
pnpm -r run build          # build all packages
pnpm -r run test           # 145 tests across 4 packages
```

## Running the binaries from this monorepo

The `harness` and `harness-hook` binaries aren't on your `$PATH` after
`pnpm install` — they're inside `packages/cli/bin/` and `packages/hook/bin/`.
Two ways to make them globally invocable for development:

### Option A: pnpm link --global (recommended for dogfooding)

```bash
# One-time pnpm setup (creates ~/.local/share/pnpm and adds it to PATH).
pnpm setup
source ~/.bashrc           # or ~/.zshrc — wherever pnpm setup wrote the export

# Link both packages globally.
cd packages/hook && pnpm link --global && cd -
cd packages/cli  && pnpm link --global && cd -

# Verify.
which harness               # → ~/.local/share/pnpm/harness
which harness-hook          # → ~/.local/share/pnpm/harness-hook
harness --help
```

The links are symlinks back into this monorepo. Edit-and-rebuild
(`pnpm --filter @harness/<pkg> run build`) takes effect immediately —
no relink needed.

### Option B: invoke by absolute path

If you don't want to mess with global links, just call the bin scripts
directly:

```bash
/path/to/claude-snaps/packages/cli/bin/harness init
/path/to/claude-snaps/packages/hook/bin/harness-hook --session-id test --cwd "$(pwd)"
```

`harness install-hook` writes the **bare command** (`harness-hook`) into
`.claude/settings.json`, assuming it's on `$PATH`. If you use Option B,
hand-edit the generated entry to use the absolute path, or temporarily
add `packages/hook/bin` to `$PATH` for the Claude Code process.

## Dogfooding the hook

The point of dogfooding is to run the real Claude Code SessionStart
hook against this monorepo and confirm the contract works end-to-end.
Two passes: a debug pass (capture what Claude Code actually sends) and
a real pass (snapshot a real session).

### Debug pass: capture the actual hook input

Before relying on `harness-hook`, verify what Claude Code is actually
passing. Drop this debug script somewhere on `$PATH`:

```bash
cat > /tmp/harness-debug-hook <<'EOF'
#!/usr/bin/env bash
LOG=/tmp/harness-debug.log
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
echo "ARGV: $*" >> "$LOG"
echo "ENV (CLAUDE_*):" >> "$LOG"
env | grep -i ^claude >> "$LOG" || echo "  (none)" >> "$LOG"
echo "STDIN:" >> "$LOG"
cat >> "$LOG"
echo "" >> "$LOG"
echo "---" >> "$LOG"
EOF
chmod +x /tmp/harness-debug-hook
```

Wire it in your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "/tmp/harness-debug-hook" }] }
    ]
  }
}
```

Then exercise three Claude Code invocations from a fresh terminal:

1. `claude` (cold start) — kill the session immediately with `/exit`.
2. `claude --continue` — same, immediate exit.
3. `claude` then `/clear` then `/exit` — captures the `clear` source.

`tail -F /tmp/harness-debug.log` will show the actual ARGV / env / stdin
JSON for each invocation. Compare against [spec/hooks.md §1](spec/hooks.md)
— the spec was amended after the first dogfood pass to match Claude
Code's real contract (stdin JSON primary, snake_case fields, no
`CLAUDE_SESSION_ID` env). If you find a divergence from the spec, file
an issue or amend the spec — the spec follows reality, not the other
way around.

### Real pass: snapshot a real session

Once the debug pass confirms the contract, swap the debug hook for the
real `harness-hook`:

```bash
cd /path/to/your/project
harness init                # if not already done
harness install-hook        # interactive y/N + diff preview
```

Then use Claude Code normally for a few sessions. After each:

```bash
harness log                 # should show one snapshot per session
harness diff <id-A> <id-B>  # see what changed between sessions
```

Check that:

- ✅ Each snapshot has a non-empty `sessionId` matching what Claude Code
  reports (look at `.claude/projects/<project>/<session>.jsonl`).
- ✅ Snapshots chain: each new one's `parentIds` includes the previous tip.
- ✅ `codePin` matches `git rev-parse HEAD` at session-start time.
- ✅ `apmLockHash` is null (this project doesn't use APM) or stable
  across sessions where the lockfile didn't change.
- ✅ Each hook fires in p95 < 200ms — instrument with
  `time harness-hook < input.json` to measure.

If any of those fail, the failure mode tells you what needs fixing.

### Free observability: the JSONL hook-audit recipe

Claude Code logs every hook firing into the session JSONL as an
`attachment` entry. You don't need to instrument the hook to verify it
fires correctly — `tail` the JSONL.

```bash
# Find the active session JSONL for your project.
ls -lt ~/.claude/projects/$(pwd | tr / -)/*.jsonl | head -1

# Stream every hook attachment as it lands. Each line shows the hook's
# name, command, exit code, and duration. Our hook always exits 0 by
# defense-in-depth (spec/hooks.md §1.5); this is how you verify it.
tail -F ~/.claude/projects/$(pwd | tr / -)/<id>.jsonl | \
  jq -c 'select(.type=="attachment" and .attachment.hookEvent) |
         {time:.timestamp,
          name:.attachment.hookName,
          exit:.attachment.exitCode,
          ms:.attachment.durationMs,
          stderr:.attachment.stderr}'
```

What to look for:

- **One entry per `SessionStart` event**, with `hookName: "SessionStart:<source>"`
  where `<source>` is `startup`, `resume`, `clear`, or `compact`.
- **`exitCode: 0`** every time. A non-zero exit indicates either the
  defense-in-depth pattern broke or you're not running our hook.
- **`durationMs` under 200**. The p95 budget from
  [spec/hooks.md §5](spec/hooks.md). 50ms is typical.

The JSONL records hook **outputs** (stdout / stderr / exitCode /
durationMs) but not the **stdin payload** Claude Code sent. To capture
that, drop in the [`/tmp/harness-debug-hook` script](#debug-pass-capture-the-actual-hook-input)
above — that one logs ARGV / env / stdin verbatim.

**Field-name gotcha.** The JSONL itself uses `sessionId` (camelCase)
while the hook stdin contract uses `session_id` (snake_case). Both refer
to the same UUID; don't conflate when cross-referencing across the two
formats.

## Releasing (future)

When the project ships via npm, `pnpm link --global` goes away —
`npm install -g @harness/cli` will be the user-facing path. Until then,
the dogfood path above is the supported way for contributors and
maintainers to try the binaries against real workloads.

## Test gates

A change to any package must keep all four gates green before merging:

```bash
pnpm --filter @harness/core test   # gate 4: 94 tests
pnpm --filter @harness/cli  test   # gate 5: 35 tests
pnpm --filter @harness/hook test   # gate 6: 16 tests
pnpm --filter @harness/cli exec vitest run test/e2e.test.ts   # gate 7: 2 tests
python3 scripts/check_schema_agreement.py    # spec gate: SQL CHECK ↔ JSON Schema
python3 scripts/build_examples.py            # spec gate: examples regenerate identically
```
