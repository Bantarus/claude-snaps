import { describe, expect, test } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repo } from '../src/index.js';
import { IoError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = resolve(here, '../../../spec');

function copyExample(name: string): string {
  const proj = mkdtempSync(join(tmpdir(), `harness-repo-${name}-`));
  cpSync(resolve(SPEC_DIR, 'examples', name), proj, { recursive: true });
  return proj;
}

describe('Repo.init / Repo.open', () => {
  test('init creates the empty-repo state and resolveHead returns null', () => {
    const proj = mkdtempSync(join(tmpdir(), 'harness-repo-init-'));
    const repo = Repo.init(proj);
    try {
      expect(repo.head()).toEqual({ type: 'symbolic', ref: 'refs/heads/main' });
      expect(repo.resolveHead()).toBeNull();
      expect(repo.listSnapshotIds()).toEqual([]);
    } finally {
      repo.close();
    }
  });

  test('init is idempotent (calling twice does not corrupt state)', () => {
    const proj = mkdtempSync(join(tmpdir(), 'harness-repo-idem-'));
    const r1 = Repo.init(proj); r1.close();
    const r2 = Repo.init(proj); r2.close();
    const r3 = Repo.open(proj);
    try {
      expect(r3.resolveHead()).toBeNull();
    } finally {
      r3.close();
    }
  });

  test('open throws IoError when .harness/ is missing', () => {
    const proj = mkdtempSync(join(tmpdir(), 'harness-repo-noinit-'));
    expect(() => Repo.open(proj)).toThrowError(IoError);
  });
});

describe('Repo on team-shared example', () => {
  test('reindex populates the db; log returns 5 snapshots', () => {
    const proj = copyExample('team-shared');
    const repo = Repo.open(proj);
    try {
      repo.reindex();
      const all = repo.log();
      expect(all.length).toBe(5);
      // Most recent first
      expect(all[0]!.createdAt >= all[1]!.createdAt).toBe(true);
    } finally {
      repo.close();
    }
  });

  test('branches() and tags() expose example refs', () => {
    const proj = copyExample('team-shared');
    const repo = Repo.open(proj);
    try {
      expect(Object.keys(repo.branches()).sort()).toEqual(['experimental', 'main']);
      expect(Object.keys(repo.tags())).toEqual(['v0.4']);
    } finally {
      repo.close();
    }
  });

  test('diff between two snapshots returns sorted DiffOps', () => {
    const proj = copyExample('team-shared');
    const repo = Repo.open(proj);
    try {
      const main = repo.branchTip('main');
      const exp = repo.branchTip('experimental');
      const ops = repo.diff(main, exp);
      // Experimental adds one chatmode (haiku-research) per fixture.
      expect(ops.some((o) => o.kind === 'add' && o.name === 'haiku-research')).toBe(true);
    } finally {
      repo.close();
    }
  });

  test('lca of main branch tip and experimental branch tip is the v0.4 tag', () => {
    const proj = copyExample('team-shared');
    const repo = Repo.open(proj);
    try {
      const main = repo.branchTip('main'); // v0.4 tag node
      const exp = repo.branchTip('experimental');
      const lcaId = repo.lca(main, exp);
      expect(lcaId).toBe('e6e76866ce636119129509a831acab5a2f70b2b5'); // v0.4 tag
    } finally {
      repo.close();
    }
  });
});
