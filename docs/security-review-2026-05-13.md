# Pre-public-release security review — claude-snaps

**Date:** 2026-05-13
**Repo:** `Bantarus/claude-snaps` (currently private, evaluating for public flip)
**Reviewed at commit:** `b611edb` (plus uncommitted README/CONTRIBUTING work) — repo state matches v0.5.0 tag content.
**Scope:** entire repo, current tree + full 97-commit git history, all 230 tracked files.

## Verdict

**Not ready to flip public yet.** One **HIGH-severity** finding (path
traversal in the reproducer's subtractive cleanup) is a real
exploitability vector if a user runs `harness reproduce` against a
snapshot from an untrusted repo. Zero criticals; zero
secrets/credentials leaked anywhere in 97 commits; supply chain is
clean; workflow is safe-by-design for public PRs. Fix the HIGH +
4 of the 6 mediums first, then the repo is safe to publish.

## Methodology

Five parallel specialized review tracks, plus a maintainer scoping
pass. All tracks were read-only — no edits were made during the
audit.

| # | Track | Surface |
|---|---|---|
| 1 | Secrets + personal-info scan | Working tree + full git history; entropy/prefix patterns for known credential shapes; personal paths; emails; internal URLs |
| 2 | Code-level security review | `packages/core`, `packages/cli`, `packages/hook` runtime code — injection, traversal, JSON parsing, crypto, hook defense-in-depth |
| 3 | Hook + install-hook + reproduce safety | Operations performed on user systems (install-hook, harness-hook, reproduce) + plugin manifest/hooks |
| 4 | Supply chain + CI/CD | `package.json` × 4, `pnpm-lock.yaml`, `.github/workflows/`, third-party action pinning, dep CVE posture |
| 5 | Docs + plugin pre-public review | READMEs, CONTRIBUTING, SECURITY, scaffolding prompt safety, SOAK reports, plugin allowed-tools, $ARGUMENTS quoting |

---

## Findings — consolidated table

| # | Sev | Track | Location | Issue |
|---|---|---|---|---|
| 1 | **HIGH** | code | [`packages/core/src/reproduce.ts:338-344`](../packages/core/src/reproduce.ts#L338-L344) | `isPathUnderClaudeDir` does a string-prefix check (`p === '.claude' \|\| p.startsWith('.claude/')`), so `.claude/../etc/passwd` passes. A crafted snapshot blob committed to a hostile repo can drive `rmSync(..., { recursive: true, force: true })` to arbitrary paths under the project root when an unwitting user runs `harness reproduce`. Also accepts absolute paths (`/etc/passwd` after `path.join`). |
| 2 | **MED** | hook | [`packages/cli/src/commands/install_hook.ts:74-103`](../packages/cli/src/commands/install_hook.ts#L74-L103) + [`packages/core/src/reproduce.ts:373-380`](../packages/core/src/reproduce.ts#L373-L380) | No symlink guard on `.claude/settings.json` (install-hook) or `.claude/` (reproduce). `cpSync` follows symlinks; a `.claude/` symlink to a wider tree copies the whole tree into backup, then subtractive `rmSync` can traverse outside the intended subtree. |
| 3 | **MED** | code+hook | [`packages/hook/src/args.ts:108-109`](../packages/hook/src/args.ts#L108-L109), [`packages/core/src/blob.ts:33-42`](../packages/core/src/blob.ts#L33-L42) | Unbounded stdin read (`readFileSync(0, 'utf-8')`) and unbounded snapshot-blob read. A multi-GB payload OOMs the process. OOM bypasses defense-in-depth try/catch because the allocation itself throws `RangeError` outside the catch. The `TRANSCRIPT_PEEK_BYTES = 64KB` pattern in [`capture.ts:454`](../packages/core/src/capture.ts#L454) is the correct model. |
| 4 | **MED** | code | [`packages/core/src/ingest.ts:79,107`](../packages/core/src/ingest.ts#L79) | Same OOM family — `harness ingest-session` reads full transcript JSONL into a string via `readFileSync`. Multi-GB transcript OOMs the CLI. Lower exposure than the hook (manual command), but still on the user's machine. |
| 5 | **MED** | hook | [`packages/core/src/reproduce.ts:362-366`](../packages/core/src/reproduce.ts#L362-L366) | Backup-dir name uses `new Date().toISOString()` with `:`/`.` swapped — ms-precision. Two rapid `harness reproduce` calls in the same millisecond hit the same path; `mkdirSync({recursive:true})` doesn't error, `cpSync({recursive:true})` merges, silently destroying the boundary between two backups. |
| 6 | **MED** | hook | [`packages/core/src/apm.ts:285-304`](../packages/core/src/apm.ts#L285-L304) | `apm.lock.yaml.harness-backup` is overwritten on every `reproduce` — asymmetric with `.claude.harness-backup-<ts>/`. Reproduce A (good backup) then reproduce B (wrong) loses A's lockfile-pre-state. |
| 7 | **MED** | docs | `SOAK_FINDINGS.md`, `SOAK_FINDINGS_v0_2.md`, `SOAK_FINDINGS_v0_3.md`, `soak-report.txt`, `soak-report-v0_2.txt`, `soak-report-v0_3.txt` (6 files at repo root) | Leak maintainer's `~/harness-dogfood-soak` path + ~50 real Claude Code session UUIDs across the three reports. UUIDs alone are low-sensitivity but combined with the home path they over-fingerprint the maintainer's machine. |
| 8 | **LOW** | code | [`packages/cli/src/commands/install_hook.ts:151-153`](../packages/cli/src/commands/install_hook.ts#L151-L153) | Backup `.bak` write is non-atomic (the main settings.json write IS atomic). Interrupted write = corrupt backup. |
| 9 | **LOW** | code | [`packages/core/src/repo.ts:67-83`](../packages/core/src/repo.ts#L67-L83) | `Repo.init`'s `defaultBranch` value isn't validated against `REF_NAME_RE`. `harness init --branch=$'foo\nref: refs/heads/bar'` writes a malformed HEAD. Self-inflicted, but the other ref-writing paths (`branch`/`tag` commands, `writeRef`) all validate; init should match. |
| 10 | **LOW** | hook | [`packages/cli/src/commands/install_hook.ts:68-72`](../packages/cli/src/commands/install_hook.ts#L68-L72) | `mkdirSync(.claude/)` runs BEFORE the user confirms at line 162. If the user answers `n`, an empty `.claude/` directory is left behind. Cosmetic but it's a state mutation before consent. |
| 11 | **LOW** | hook | [`packages/hook/src/main.ts:91`](../packages/hook/src/main.ts#L91) | Cache-write failure logs `warn: cache write failed` to stderr. Claude Code may surface as user-visible noise. Best-effort behavior is correct; messaging is not. |
| 12 | **LOW** | CI | [`.github/workflows/ci-playbook.yml`](../.github/workflows/ci-playbook.yml) | No `permissions:` block declared. Falls back to repo default which is typically write-broad. Workflow does no writes today; belt-and-suspenders against future drift. |
| 13 | **LOW** | CI | (no `.github/dependabot.yml`) | No automated CVE surfacing for npm or github-actions ecosystems. Future advisories on pinned deps won't generate PRs. |
| 14 | **LOW** | docs | [`scripts/dogfood-v0_4/README.md:205`](../scripts/dogfood-v0_4/README.md#L205), [`scripts/dogfood-v0_4/PLAYBOOK.md:206`](../scripts/dogfood-v0_4/PLAYBOOK.md#L206) | Hardcoded `cd ~/DEV/claude-snaps` in instructions. The surrounding comment already says "or wherever your main worktree is" — example should match. |
| 15 | **LOW** | docs | `docs/plugin-kickoff-prompt.md` (lines 25, 34, 247, 327), `docs/v0_5_plugin_smoke_report.md:247`, `docs/session-metrics-prompt.md:117` | Broken `~/.claude/projects/.../memory/*.md` links — file paths that only exist on the maintainer's machine. Will 404 in GitHub render. |
| 16 | **LOW** | docs | [`plugin/.claude-plugin/plugin.json`](../plugin/.claude-plugin/plugin.json) lines 6-7 | Repo URLs lowercased `bantarus`; README badges use canonical `Bantarus`. GitHub is case-insensitive in resolution but mixed casing is sloppy. |
| 17 | **INFO** | secrets | `scripts/dogfood-v0_4/cases/w12_session_metrics.sh:164-169` | `SECRET_CANARY_*` prefixes are sentinel tokens for the W12.5 privacy fuzz gate (not real secrets). External scanners (truffleHog, etc.) will flag them after public flip. |
| 18 | **INFO** | secrets | `spec/apm-integration.md`, `spec/examples/.../*.json` | Fictitious package names `microsoft/apm-sample-package`, `microsoft/common-utilities`, etc. under the `microsoft/` org. Only `microsoft/apm` is real. A naive reader might try to `apm install microsoft/apm-sample-package` and 404. |
| 19 | **INFO** | docs | [`SECURITY.md`](../SECURITY.md) reporting URL | URL is canonical GitHub PSA pattern — works the moment repo is public. Toggle "Private vulnerability reporting" in Settings → Security to be safe (default-on for public repos but confirm). |
| 20 | **INFO** | code | [`packages/cli/src/main.ts:135-158`](../packages/cli/src/main.ts#L135-L158) | CLI prints full stack on error. Standard dev-CLI behavior; no env-derived secrets observed in the error paths, but document the trade-off. |

---

## Must-fix before public flip (5 items)

These are where "public" materially changes the threat model.

### 1. HIGH — path traversal in reproducer (#1)

Replace the string-prefix check with a resolved-path comparison:

```ts
function isPathUnderClaudeDir(rel: string, projectRoot: string): boolean {
  const claudeAbs = path.resolve(projectRoot, '.claude');
  const targetAbs = path.resolve(projectRoot, rel);
  if (targetAbs === claudeAbs) return true;
  const relInside = path.relative(claudeAbs, targetAbs);
  return relInside !== '' && !relInside.startsWith('..') && !path.isAbsolute(relInside);
}
```

Add a test fixture with `.claude/../escape` in `deployed_files` and
assert the reproducer skips it (or aborts with a clear error). Same
hardening for `/etc/passwd` literal absolute paths.

### 2. MED — symlink guards (#2)

In `install_hook.ts` step 4, before any read/write of
`.claude/settings.json`: `lstatSync` it; if symlink, refuse with a
clear error (or require an explicit `--force-symlink` opt-in). Same
for `.claude/` in `reproduce.ts` before `cpSync` / subtractive
`rmSync`. Pass `{ verbatimSymlinks: true }` to `cpSync` so the
backup preserves links instead of dereferencing.

### 3. MED — bound the I/O reads (#3 + #4)

Three reads need caps:

- Hook stdin: 1 MiB. Use `read(0, buffer, 0, 1_048_576, null)` or
  equivalent; overflow → return empty `{}` and exit 0.
- Snapshot blob in `blob.ts:readSnapshot`: 16 MiB.
- Transcript JSONL in `ingest.ts:parseTranscriptJsonl`: stream
  line-by-line via `createReadStream` + `readline`. Or `statSync`
  precheck with a max-file-size and reject above it.

The `TRANSCRIPT_PEEK_BYTES = 64 * 1024` pattern in `capture.ts:454`
is the model — extend to these three call sites.

### 4. MED — scrub + move SOAK artifacts (#7)

```bash
mkdir -p docs/soak
git mv SOAK_FINDINGS.md SOAK_FINDINGS_v0_2.md SOAK_FINDINGS_v0_3.md \
       soak-report.txt soak-report-v0_2.txt soak-report-v0_3.txt \
       docs/soak/
sed -i 's|~|~|g' docs/soak/*.md docs/soak/*.txt
```

The UUIDs themselves are random v4s with no transcript content
attached — fine to keep. The path scrub is the necessary part.

### 5. LOW — workflow hardening (#12 + #13)

Add to top of `.github/workflows/ci-playbook.yml`:

```yaml
permissions:
  contents: read
```

Add `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

---

## Should-fix soon (not blocking the flip)

| # | Fix |
|---|---|
| 5 | Append `-<6 hex>` random suffix to reproduce backup-dir name |
| 6 | Version `apm.lock.yaml.harness-backup-<ts>` symmetric with `.claude` backup |
| 9 | Run `--branch` value through `REF_NAME_RE` at `Repo.init` |
| 15 | Scrub `~/.claude/...` memory-path links in `docs/*.md` (rewrite as plain text "(maintainer's local memory file)" or remove) |
| 14 | Generic placeholder `/path/to/claude-snaps` in `scripts/dogfood-v0_4/README.md` + `PLAYBOOK.md` |

---

## Optional polish (single hygiene commit)

#8, #10, #11, #16, #17 (`SECRET_CANARY_*` → `TEST_CANARY_*`),
#18 (one-line disclaimer in `spec/apm-integration.md`), #19 (toggle
in repo Settings after flip), #20 (document the stack-trace
exposure trade-off).

---

## What's already strong (cleared / verified safe)

### Secrets posture
- **No credentials, keys, or tokens** anywhere in tree or 97-commit history. Full credential-prefix sweep clean: `sk-`, `gho_`/`ghp_`, `AKIA`, `AIza`, PEM private keys, `Authorization: Bearer`, `api_key=`, `password=`.
- **`.gitignore`** correctly excludes `.env*`, `/.harness/` (root-only — fixtures under `spec/examples/*/.harness/` are intentionally tracked), `coverage/`, `node_modules/`, `dist/`.
- Test fixtures use **reserved-domain placeholders**: `ben@example.com` (RFC 2606), `fixture@harness.test` (RFC 6761).
- No collaborator email leakage — author throughout history is `Bantarus <bantarusgaming@gmail.com>` only.

### Supply chain
- **Lockfile**: 131 resolutions, all from `registry.npmjs.org` with sha512 integrity; no `git:`/`http:`/`file:` URIs; no `hasInstallScript`/`requiresBuild` beyond the allowed `esbuild` (`pnpm.onlyBuiltDependencies: ["esbuild"]`).
- **Deps current**: `yaml@2.8.3`, `vitest@3.2.4`, `typescript@5.9.3`, `tsx@4.21.0`, `@types/node@24.12.2`. No exploitable CVEs in current usage. (Note: esbuild ≤0.24.2 has a dev-server SSRF — affects only `esbuild serve` which this repo never invokes.)

### Code-level
- **No shell injection**: every `child_process` invocation uses `execFile`/`spawnSync` with `[args]` arrays. No `exec`/`{ shell: true }` in production code.
- **JSON parsing**: every `JSON.parse` is `try/catch`'d. The ingest privacy whitelist uses named accessors throughout — `ingest.ts:135-156` is exemplary — no `Object.assign` of attacker JSON into typed objects.
- **Crypto**: `sha256` pinned literally everywhere (`canonical.ts:82`, `apm.ts:209,245`, `capture.ts:181,188,358`). No algorithm-agility helper, no caller-supplied algorithm name. Canonical JSON is deterministic at every depth; NaN/Infinity rejected explicitly.
- **Atomic writes**: tmp+fsync+rename for snapshot writes (`blob.ts:82-97`), ref writes (`refs.ts:112-129`), and primary settings.json writes (`install_hook.ts:203-208`). SQLite uses WAL.
- **Ref-name validation**: three independent layers of `^[A-Za-z0-9._/-]+$` + `..` + `.lock` rejection across `commands/branch.ts`, `commands/tag.ts`, `refs.ts`. Only gap is `Repo.init` (finding #9).

### Hook + reproduce + install-hook
- **Hook always exits 0**: outer try/catch/finally in [`packages/hook/src/main.ts:27-101`](../packages/hook/src/main.ts#L27-L101) plus bin-shim loader catch. No `throw` escapes. Defense in depth verified end-to-end.
- **Hook never writes outside `.harness/`**: grep across @harness/hook + @harness/core confirms all writes are scoped to `.harness/` (or, in reproduce, to the explicitly contracted `.claude/` + `apm.lock.yaml`).
- **Install-hook**: backup-before-write, interactive default-no confirm, dirty-git refuse (with `--force` bypass), deep-clone preservation of existing user hooks, refuse on malformed settings JSON. Test coverage at `install_hook.test.ts` covers all five paths.
- **Reproduce**: backup-before-mutate (unconditional, per spec §6.1); HEAD-advance only on success; dry-run truly read-only; APM-not-found aborts BEFORE backup (matches spec); subtractive `rmSync` gated on the (currently flawed but in-spirit-correct) `isPathUnderClaudeDir` guard.
- **Privacy whitelist (ingest)**: strict named-accessor parsing only. Tool inputs, message text, thinking blocks, system prompts are never accessed. W12.5 fuzz canary CI gate enforces zero leakage.

### CI / workflow
- **Trigger config**: `pull_request` (not `pull_request_target`); `actions/checkout@v4` defaults to safe PR-head checkout without secret exposure. Forked PRs will run untrusted code without secret access.
- **Zero `secrets.*` references** in the workflow. Only implicit `GITHUB_TOKEN`.
- **Third-party actions**: all first-party (`actions/*` = GitHub itself) or well-known org (`pnpm/*`), tag-pinned at `@v4`/`@v3`. SHA-pinning would be gold-standard but tag-pinning is industry-acceptable.
- **`upload-artifact`** on failure (cip-scratch, 7-day retention) contains only synthetic fixtures and test transcripts. No secrets, no real user data.
- **`scripts/dogfood-v0_4/ci-playbook.sh`** has `set -uo pipefail`, no `curl | sh`, no `eval`, clean.

### Plugin
- **Manifest** (`plugin/.claude-plugin/plugin.json`): declares only `name`/`version`/`description`/`author`/`homepage`/`repository`. No special scopes.
- **Hook installation** (`plugin/hooks/hooks.json`): only `SessionStart` + `UserPromptSubmit`, matcher `*`, same as `harness install-hook`. Activation is opt-in via `--plugin-dir`.
- **Slash commands** (6 total): every command declares scoped `allowed-tools: Bash(harness *)` patterns. No raw `Bash`, no `*` wildcards. `disable-model-invocation: true` on the mutating commands (`snap`/`restore`/`status`/`trajectory`).
- **`$ARGUMENTS` quoting**: `snap.md` and `trajectory.md` use `"$ARGUMENTS"` (quoted, with inline justification for the literal `<manual>` case). Other commands intentionally unquoted to allow flag-splitting (`--all`, `--by-tool`) — correct.
- **Subagents**: `harness-archeologist` (haiku, read-only verbs only); `harness-reproducer-pilot` (sonnet, dry-run-confirm-execute pattern). Both appropriately scoped.

### Docs
- **README scaffolding prompt** — multiple safety gates: APM warn-only, install-hook diff approval, "don't proceed on uncommitted changes". No instruction Claude could plausibly misinterpret destructively.
- **SECURITY.md** reporting channel uses the canonical GitHub PSA URL pattern; works automatically once public.
- **Fixture realism**: `spec/examples/**/*.json` use placeholder data (`ben@example.com`, hand-crafted snapshot IDs, hex codePins). No real-session leakage.

---

## Suggested commit plan

If you decide to fix in-repo before flip, one commit per logical unit:

1. `fix(reproduce): path-traversal in subtractive cleanup (#1)`
2. `fix(io): bound stdin/blob/transcript reads (#3, #4)`
3. `fix(install-hook,reproduce): symlink guards (#2)`
4. `chore(docs): move SOAK files to docs/soak + scrub home paths (#7)`
5. `chore(ci): add permissions: read + dependabot config (#12, #13)`
6. `chore: hygiene pass — atomic .bak, init branch validation, mkdir-after-confirm, plugin.json casing (#8, #9, #10, #16)`

Each commit is independently revertable. The first three are
code changes that should ship to a new tag (`v0.5.1`) before the
public flip.

---

## What's pending the maintainer (not fixable in-repo)

- Toggle **"Private vulnerability reporting"** in repo Settings →
  Security after the public flip (default-on for public repos but
  confirm).
- Optionally rename `SECRET_CANARY_*` → `TEST_CANARY_*` to avoid
  scanner false-positives.
- Optionally add a one-line disclaimer to `spec/apm-integration.md`
  noting that `microsoft/*` example package names are illustrative.
