import { join } from 'node:path';
import { Repo, migrateV1ToV2 } from '@harness/core';
import { c } from '../format.js';
import type { ParsedArgs } from '../main.js';

/**
 * `harness migrate`
 *
 * Idempotent in-place migration from v0.1.x to v0.2.0. Schema
 * migrations (001 → 002 → 003) are applied transparently when the
 * Repo opens; this command performs the BLOB-layer migration the
 * schema can't:
 *
 *   - Rewrites every v0.1.x snapshot blob under the v0.2.0 derivation
 *     rule (§3.1 strip): drops `sessionId`, maps legacy kinds to
 *     `manual`, sets formatVersion='0.2'. Recomputes the snapshot id.
 *   - Deduplicates compositions that became byte-identical under the
 *     new derivation.
 *   - Updates parent references in all blobs.
 *   - Updates ref files (heads, tags, detached HEAD).
 *   - Rewrites `attributions.snapshot_id` to point at the new ids.
 *
 * Reports counts so the user knows what shifted.
 */
export async function cmdMigrate(_parsed: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const harnessDir = join(cwd, '.harness');

  // Force the schema migrations to run (Repo.open chains 001 → 002 →
  // 003 in IndexDb.ensureSchema). Then close before running the
  // blob-layer migration, which opens its own connection with FK off.
  const repo = Repo.open(cwd);
  repo.close();

  process.stdout.write('Migrating to format v0.2.0...\n');

  const result = migrateV1ToV2(harnessDir);

  if (result.alreadyMigrated) {
    process.stdout.write(
      c.dim(`  Nothing to migrate (${result.blobsScanned} blobs already at v0.2.0).\n`),
    );
    return 0;
  }

  process.stdout.write(
    `  ${c.add('+')} ${result.blobsRewritten} snapshot blob${result.blobsRewritten === 1 ? '' : 's'} rewritten\n` +
    `  ${result.duplicatesMerged > 0 ? c.chg('~') : c.dim('·')} ${result.duplicatesMerged} duplicate${result.duplicatesMerged === 1 ? '' : 's'} merged\n` +
    `  ${result.refsUpdated > 0 ? c.add('+') : c.dim('·')} ${result.refsUpdated} ref${result.refsUpdated === 1 ? '' : 's'} updated\n` +
    `  ${c.add('+')} ${result.attributionsRewritten} attribution row${result.attributionsRewritten === 1 ? '' : 's'} rewritten\n` +
    `\nDone. Verify with: harness log\n`,
  );
  return 0;
}
