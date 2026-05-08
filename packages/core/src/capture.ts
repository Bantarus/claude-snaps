import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { readApmLock, type ApmLockEntry } from './apm.js';
import { IoError } from './errors.js';
import type { Module, ModuleSource, ModuleType } from './types.js';

// captureCurrentState walks `<projectRoot>/.claude/`, identifies every
// active primitive, optionally enriches it with APM source attribution
// from `<projectRoot>/apm.lock.yaml`, and returns the canonical Module[]
// that the hook (and the editor's working-tree view) will hand to
// writeSnapshot.
//
// One implementation, two consumers — see spec/hooks.md §2.1.
//
// captureCurrentStateFast (below) is the hot-path companion: a cheap
// fingerprint over filesystem mtimes/sizes, used by the hook to detect
// "no change since last fire" without doing the full walk + frontmatter
// parses. False negatives cost at most one missed attribution event.

const BUILTIN_TOOLS = [
  'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write',
  'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit',
] as const;

/**
 * Walk `<projectRoot>/.claude/` (and `CLAUDE.md` at the project root),
 * enumerate primitives, and produce a canonical Module[]. The order of
 * the array follows spec/hooks.md §2.2 (by canonical type, then by
 * name UTF-16 code units) so identical compositions produce identical
 * snapshot ids.
 *
 * @throws {IoError} on filesystem failure other than ENOENT.
 */
export function captureCurrentState(projectRoot: string): Module[] {
  const claudeDir = join(projectRoot, '.claude');
  const modules: Module[] = [];

  // chatmode + agent: .claude/agents/*.md
  for (const path of safeListDir(join(claudeDir, 'agents'), '.md')) {
    const name = basename(path, '.md');
    const type: ModuleType = inferAgentTypeFromFrontmatter(path);
    modules.push({
      type, name,
      enabled: true,
      configHash: hashFile(path),
      source: { kind: 'local', path: relativePosix(projectRoot, path) },
    });
  }

  // skill: .claude/skills/*/SKILL.md
  const skillsDir = join(claudeDir, 'skills');
  if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
    for (const entry of readdirSync(skillsDir)) {
      const dir = join(skillsDir, entry);
      const skillFile = join(dir, 'SKILL.md');
      if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;
      modules.push({
        type: 'skill', name: entry,
        enabled: true,
        configHash: hashFile(skillFile),
        source: { kind: 'local', path: relativePosix(projectRoot, skillFile) },
      });
    }
  }

  // prompt: .claude/commands/*.md (slash command name = '/' + filename)
  for (const path of safeListDir(join(claudeDir, 'commands'), '.md')) {
    const name = '/' + basename(path, '.md');
    modules.push({
      type: 'prompt', name,
      enabled: true,
      configHash: hashFile(path),
      source: { kind: 'local', path: relativePosix(projectRoot, path) },
    });
  }

  // style: .claude/output-styles/*.md
  for (const path of safeListDir(join(claudeDir, 'output-styles'), '.md')) {
    modules.push({
      type: 'style', name: basename(path, '.md'),
      enabled: true,
      configHash: hashFile(path),
      source: { kind: 'local', path: relativePosix(projectRoot, path) },
    });
  }

  // hook + mcp: from .claude/settings.json
  const settingsPath = join(claudeDir, 'settings.json');
  if (existsSync(settingsPath)) {
    const settings = readSettingsJson(settingsPath);
    for (const [name, block] of mcpServerEntries(settings)) {
      modules.push({
        type: 'mcp', name, enabled: true,
        configHash: hashJson(block),
        source: { kind: 'local', path: relativePosix(projectRoot, settingsPath) },
      });
    }
    for (const [name, block] of hookEntries(settings)) {
      modules.push({
        type: 'hook', name, enabled: true,
        configHash: hashJson(block),
        source: { kind: 'local', path: relativePosix(projectRoot, settingsPath) },
      });
    }
  }

  // instruction: CLAUDE.md (project) and AGENTS.md if present
  for (const fname of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(projectRoot, fname);
    if (existsSync(p) && statSync(p).isFile()) {
      modules.push({
        type: 'instruction', name: fname,
        enabled: true,
        configHash: hashFile(p),
        source: { kind: 'local', path: fname },
      });
    }
  }

  // builtin: Claude Code's built-in tool surface. Always present, always
  // enabled, no path. Fixed set in v0.1; future versions may detect
  // subsets via permissions config.
  for (const name of BUILTIN_TOOLS) {
    modules.push({
      type: 'mcp', name, enabled: true, source: { kind: 'builtin' },
    });
  }

  // APM enrichment: replace `local` modules whose path is in a lockfile
  // entry's deployed_files with `apm` modules. Per spec/apm-integration.md §2.
  const lock = safeReadApmLock(projectRoot);
  if (lock !== null) {
    enrichWithApm(modules, lock);
  }

  // Stable ordering — spec/hooks.md §2.2
  return modules.sort(canonicalModuleOrder);
}

// ── private ────────────────────────────────────────────────────────────────

function safeReadApmLock(projectRoot: string): ApmLockEntry[] | null {
  try {
    return readApmLock(projectRoot);
  } catch {
    // Malformed lockfile is logged in apm.ts; capture continues without
    // APM enrichment so the snapshot still reflects the project's state.
    return null;
  }
}

function safeListDir(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch (cause) {
    throw new IoError(`failed to list ${dir}`, cause);
  }
  return entries
    .filter((n) => n.endsWith(ext))
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isFile());
}

function inferAgentTypeFromFrontmatter(path: string): ModuleType {
  // Conservative default: .claude/agents/*.md describes a subagent
  // unless its frontmatter declares it as a chatmode persona. Without
  // a frontmatter parser in v0.1, default to 'agent'; users who want
  // 'chatmode' can adjust by hand or via a future explicit marker.
  // (Sidesteps the YAML-frontmatter parser dependency for v0.1.)
  void path;
  return 'agent';
}

function hashFile(path: string): string {
  const bytes = readFileSync(path);
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function hashJson(obj: unknown): string {
  // Hash the canonical JSON representation of the block — sorted keys,
  // no whitespace — so consumers can compare configHashes across
  // pretty-printed vs minified settings.json variants.
  return 'sha256:' + createHash('sha256').update(canonicalJsonString(obj)).digest('hex');
}

function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonString).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalJsonString((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

function readSettingsJson(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // settings.json malformed — capture continues with no MCP/hook
    // attribution. Hook sites log warnings via console.
    return {};
  }
}

function mcpServerEntries(settings: Record<string, unknown>): [string, unknown][] {
  const m = settings['mcpServers'];
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return [];
  return Object.entries(m as Record<string, unknown>);
}

function hookEntries(settings: Record<string, unknown>): [string, unknown][] {
  const h = settings['hooks'];
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return [];
  // Claude Code's hooks structure is event → matcher list. Flatten to
  // (eventName-matcherIndex, matcherBlock) entries.
  const out: [string, unknown][] = [];
  for (const [eventName, value] of Object.entries(h as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      value.forEach((m, i) => out.push([`${eventName}#${i}`, m]));
    } else {
      out.push([eventName, value]);
    }
  }
  return out;
}

function enrichWithApm(modules: Module[], lock: ApmLockEntry[]): void {
  // Build (path → entry) lookup. If the same path appears in multiple
  // entries, prefer the lower-depth entry per spec/apm-integration.md §2.2.
  //
  // Local-path APM lockfile entries (added v0.4.1) list directories in
  // `deployed_files`, not individual files (e.g. `.claude/skills/test-fixture`
  // rather than `.../SKILL.md`). The path-match supports both: an exact
  // file match takes precedence, and a directory-prefix match is the
  // fallback. This keeps remote-shaped entries' file-level matching
  // unchanged while letting local-path entries enrich the modules whose
  // captured paths live under the deployed directory.
  const byPath = new Map<string, ApmLockEntry>();
  const byDir: Array<{ dir: string; entry: ApmLockEntry }> = [];
  for (const e of lock) {
    for (const p of e.deployedFiles) {
      if (looksLikeDirectory(p)) {
        byDir.push({ dir: p.replace(/\/$/, ''), entry: e });
      } else {
        const existing = byPath.get(p);
        if (existing === undefined || e.depth < existing.depth) byPath.set(p, e);
      }
    }
  }
  for (const m of modules) {
    if (m.source.kind !== 'local') continue;
    const exact = byPath.get(m.source.path);
    const entry = exact ?? findByDirPrefix(byDir, m.source.path);
    if (entry === undefined) continue;
    const newSrc: ModuleSource = {
      kind: 'apm',
      package: entry.package,
      resolvedCommit: entry.resolvedCommit,
      depth: entry.depth,
    };
    if (entry.resolvedBy !== undefined) {
      (newSrc as { resolvedBy?: string }).resolvedBy = entry.resolvedBy;
    }
    m.source = newSrc;
  }
}

function looksLikeDirectory(p: string): boolean {
  // Heuristic: directory deployed_files lack a file extension OR end
  // with `/`. APM 0.8.x emits forms like `.claude/skills/test-fixture`
  // (no extension) for skill directories. File entries always carry a
  // recognized extension (`.md`, `.json`, etc.). The check below
  // misclassifies a hypothetical extensionless file as a directory,
  // but no APM-deployed file is extensionless in the v0.1 type
  // vocabulary (format.md §2.5).
  if (p.endsWith('/')) return true;
  const base = p.split('/').pop() ?? '';
  return !base.includes('.');
}

function findByDirPrefix(
  byDir: ReadonlyArray<{ dir: string; entry: ApmLockEntry }>,
  modulePath: string,
): ApmLockEntry | undefined {
  // Longest-prefix-wins, then lower-depth-wins. Tie-broken by entry
  // order in the lockfile (which the caller sorts by depth in the
  // upstream reader). Directory boundary check: `path.startsWith(dir + '/')`
  // — prevents `.claude/skills/foo-extra` from matching dir
  // `.claude/skills/foo`.
  let best: { entry: ApmLockEntry; matchLen: number } | undefined;
  for (const { dir, entry } of byDir) {
    if (!modulePath.startsWith(`${dir}/`)) continue;
    if (
      best === undefined
      || dir.length > best.matchLen
      || (dir.length === best.matchLen && entry.depth < best.entry.depth)
    ) {
      best = { entry, matchLen: dir.length };
    }
  }
  return best?.entry;
}

const TYPE_ORDER: Record<ModuleType, number> = {
  chatmode: 0, instruction: 1, agent: 2, skill: 3,
  prompt: 4, mcp: 5, hook: 6, style: 7,
};

function canonicalModuleOrder(a: Module, b: Module): number {
  const ta = TYPE_ORDER[a.type];
  const tb = TYPE_ORDER[b.type];
  if (ta !== tb) return ta - tb;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function relativePosix(from: string, to: string): string {
  return relative(from, to).split(/[\\/]/).join('/');
}

/**
 * Fast composition fingerprint for the hook's hot-path optimization
 * (spec/hooks.md §2.4). Returns a 40-char hex digest derived from the
 * mtimes and sizes of the files that the full capture walk would read.
 * Includes `apm.lock.yaml` — a lockfile change can shift APM-source
 * module identities without any change under `.claude/`.
 *
 * Properties:
 * - Cheap. Walks the same paths as captureCurrentState but reads only
 *   directory listings and stat metadata (no file contents, no
 *   frontmatter parses). Target: <2ms p95 on a project with 200
 *   captured files.
 * - Approximate. Two compositions with structurally identical files
 *   but different mtimes produce different fingerprints (false
 *   positive — full walk runs, attribution recorded correctly). The
 *   inverse is the failure mode: if a tool modifies file content
 *   without bumping mtime/size (rare; some sandboxed editors), the
 *   fingerprint matches and the hook skips the full walk. Cost is at
 *   most one missed attribution event for that prompt — the next fire
 *   that DOES bump mtime catches up.
 * - Deterministic given filesystem state. Same inputs → same output.
 *
 * The hash composition: `(path, mtime_ms, size)` for every file plus
 * directory entries, recursively under `.claude/` and for the project-
 * root-level `CLAUDE.md`, `AGENTS.md`, and `apm.lock.yaml`. Walk order
 * is deterministic (entries sorted) so the hash is stable.
 */
export function captureCurrentStateFast(projectRoot: string): string {
  const hash = createHash('sha256');
  const claudeDir = join(projectRoot, '.claude');
  hashPath(hash, claudeDir, '.claude');
  walkAndHashFast(hash, claudeDir, '.claude');
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'apm.lock.yaml']) {
    hashPath(hash, join(projectRoot, f), f);
  }
  return hash.digest('hex').slice(0, 40);
}

function walkAndHashFast(
  hash: ReturnType<typeof createHash>,
  abs: string,
  rel: string,
): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // ENOENT and other read errors → walk truncates here
  }
  // Sort by name to make the hash deterministic across filesystems.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const childAbs = join(abs, e.name);
    const childRel = `${rel}/${e.name}`;
    hashPath(hash, childAbs, childRel);
    if (e.isDirectory()) walkAndHashFast(hash, childAbs, childRel);
  }
}

function hashPath(
  hash: ReturnType<typeof createHash>,
  abs: string,
  rel: string,
): void {
  // Single stat per path. lstat would also work; we use stat to follow
  // symlinks the same way captureCurrentState does (it readFiles them).
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    // Absent: hash a sentinel so the absence itself participates in
    // the digest (so a deletion since the last fire is detected).
    hash.update(`${rel} ABSENT\n`);
    return;
  }
  // mtimeMs + size + a one-byte type tag are sufficient to detect:
  //   - file contents changed (mtimeMs moves)
  //   - file replaced with directory (or vice versa) (type tag flips)
  //   - file truncated/extended (size moves)
  // Excludes inode number and ctime — those vary across filesystems
  // for content-equivalent state and would create spurious mismatches.
  const tag = stat.isDirectory() ? 'D' : stat.isFile() ? 'F' : 'O';
  hash.update(`${rel} ${tag} ${stat.mtimeMs} ${stat.size}\n`);
}

// ── claudeCodeVersion (v0.5.0; spec/format.md §2.1) ─────────────────────

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const TRANSCRIPT_PEEK_BYTES = 64 * 1024;

/**
 * Resolve the host CLI's Claude Code version at hook-fire time.
 *
 * Order:
 *   1. If `transcriptPath` is provided and reachable, read up to the
 *      first 64 KB and pull the `version` field from the first
 *      complete `\n`-terminated JSON line that carries one. The
 *      transcript JSONL is the canonical per-turn source — tracks
 *      auto-updates that occur mid-session that `claude --version`
 *      can't see (the running process self-identifies).
 *   2. Fallback: shell out to `claude --version` with a 2s timeout.
 *      If the binary isn't on PATH or doesn't respond, returns null.
 *
 * Returns null when neither path yields a value matching X.Y.Z.
 *
 * Read is bounded so a multi-MB transcript stays cheap. No content
 * beyond the `version` field itself is consumed.
 */
export function readClaudeCodeVersion(transcriptPath: string | undefined): string | null {
  if (transcriptPath !== undefined && transcriptPath.length > 0) {
    const v = readVersionFromTranscript(transcriptPath);
    if (v !== null) return v;
  }
  return shellOutClaudeVersion();
}

function readVersionFromTranscript(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(TRANSCRIPT_PEEK_BYTES);
    const bytes = readSync(fd, buf, 0, TRANSCRIPT_PEEK_BYTES, 0);
    if (bytes <= 0) return null;
    const text = buf.subarray(0, bytes).toString('utf-8');
    // Walk lines; first JSON line whose `version` matches X.Y.Z wins.
    // Skip the trailing partial line if no terminator was seen — better
    // null than a guess on incomplete bytes.
    const newlineEnd = text.lastIndexOf('\n');
    if (newlineEnd < 0) return null;
    for (const line of text.slice(0, newlineEnd).split('\n')) {
      if (line.length === 0) continue;
      const v = pluckVersionField(line);
      if (v !== null) return v;
    }
    return null;
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
}

function pluckVersionField(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const v = (parsed as Record<string, unknown>)['version'];
  return typeof v === 'string' && VERSION_PATTERN.test(v) ? v : null;
}

function shellOutClaudeVersion(): string | null {
  let result;
  try {
    // Bounded timeout so a wedged claude binary can't stall the hook.
    // If the call exceeds the timeout, the hook still exits 0 — we
    // just lose the version field on this fire (first-observation-wins
    // means a later fire can fill it in).
    result = spawnSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) return null;
  const m = (result.stdout ?? '').match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return m?.[1] ?? null;
}
