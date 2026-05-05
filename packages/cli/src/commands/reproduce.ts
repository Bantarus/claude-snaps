import { Repo, InvalidStateError, type ReproduceResult } from '@harness/core';
import { c } from '../format.js';
import { resolveRef } from '../resolve.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness reproduce <ref> [--dry-run]`. Materializes the snapshot at
 * <ref> into the working `.claude/` directory. APM-driven: APM is a
 * hard prerequisite for content. See spec/format.md §6.1.
 *
 * Exit codes:
 *   0 — success (apm phase succeeded or was skipped; HEAD advanced).
 *   1 — recoverable user error (apm not on PATH, install failed,
 *       configHash mismatch, ref unknown). Backup retained; HEAD not
 *       advanced.
 *   2 — internal error (caller's main wrapper handles this).
 */
export async function cmdReproduce(parsed: ParsedArgs): Promise<number> {
  const [ref] = parsed.positional;
  if (ref === undefined) {
    throw new InvalidStateError('usage: harness reproduce <ref> [--dry-run]');
  }
  const dryRun = parsed.flags['dry-run'] === true;

  const repo = Repo.open(process.cwd());
  try {
    const id = resolveRef(repo, ref);
    const result = repo.reproduce(id, { dryRun });
    renderResult(result, ref);
    if (result.apmPhase === 'failed') return 1;
    return 0;
  } finally {
    repo.close();
  }
}

function renderResult(r: ReproduceResult, refLabel: string): void {
  const out = process.stdout;
  const w = (s: string): void => { out.write(s); };
  const prefix = r.dryRun ? 'Would ' : '';
  const past = r.dryRun ? '' : 'd';
  const idShort = r.snapshotId.slice(0, 8);

  w(`${refLabel === r.snapshotId ? '' : `${c.dim(refLabel)} → `}${c.dim(idShort)}\n`);

  // Backup
  w(r.dryRun
    ? `${prefix}back up .claude/ to ${c.dim(r.backupPath)}\n`
    : `Backed up .claude/ to ${c.dim(r.backupPath)}\n`);

  // APM phase
  if (r.apmPhase === 'skipped') {
    w(`${c.dim('— APM phase skipped (no apmLockfile recorded on this snapshot)')}\n`);
  } else if (r.apmPhase === 'success') {
    w(r.dryRun
      ? `${prefix}reconstruct apm.lock.yaml + run apm install --force\n${prefix}verify ${r.apmModulesExpected} APM module(s)\n`
      : `${c.add('✓')} apm install --force succeeded; verified ${c.bold(`${r.apmModulesVerified}`)} of ${c.bold(`${r.apmModulesExpected}`)} APM module(s)\n`);
  } else {
    // failed
    w(`${c.rm('✗')} APM phase failed\n`);
    if (r.apmStderr !== undefined && r.apmStderr.trim().length > 0) {
      const indented = r.apmStderr
        .trim()
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      w(`${c.dim(indented)}\n`);
    }
    if (r.apmFailures.length > 0) {
      for (const f of r.apmFailures) {
        w(`  ${c.rm('•')} ${f.type} ${f.name}: ${f.reason}\n`);
      }
    }
  }

  // Builtins
  if (r.builtinsExpected > 0) {
    if (r.builtinsMissing.length === 0) {
      w(`${c.add('✓')} ${r.builtinsExpected} builtin(s) verified\n`);
    } else {
      const list = r.builtinsMissing.map((b) => b.name).join(', ');
      w(`${c.chg('!')} ${r.builtinsMissing.length} builtin(s) missing from host: ${list}\n`);
    }
  }

  // Local-source modules — reported but not materialized
  if (r.localSourceReported.length > 0) {
    w(`${c.dim('— Local-source modules NOT reproduced (per §6.1; APM only):')}\n`);
    for (const m of r.localSourceReported) {
      w(`    ${c.dim(`${m.type} ${m.name} (${m.path})`)}\n`);
    }
  }

  // HEAD
  if (r.dryRun) {
    w(`${prefix}advance HEAD to ${c.dim(idShort)}\n`);
  } else if (r.headAdvanced) {
    w(`HEAD now at ${c.dim(idShort)} (detached)\n`);
  } else {
    w(`${c.rm('!')} HEAD NOT advanced (apm phase failed; backup retained at ${c.dim(r.backupPath)})\n`);
  }

  if (r.dryRun) {
    w(`${c.dim('(No changes made.)')}\n`);
  } else if (r.apmPhase !== 'failed') {
    w(`${c.dim(`Backup retained at ${r.backupPath}`)}\n`);
  }

  // Suppress unused warning
  void past;
}
