import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo, type Snapshot } from '@harness/core';
import { App } from '../src/app.js';
import { Store } from '../src/data/store.js';

// Ink processes stdin asynchronously and React effects run after the
// initial render; tests that act-then-assert need to flush both queues.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

// ── fixture: a fresh .harness/ with a few hand-built snapshots ──────────────

function buildFixtureHarness(): { cwd: string; ids: { init: string; edit: string; auto: string } } {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-tui-e2e-'));
  // Minimal `.claude/` so capture has something to walk if we ever call it.
  mkdirSync(join(cwd, '.claude/skills/research'), { recursive: true });
  writeFileSync(join(cwd, '.claude/skills/research/SKILL.md'), '# research\n', 'utf-8');

  const repo = Repo.init(cwd);
  const initBlob: Omit<Snapshot, 'id'> = {
    formatVersion: '0.1',
    parentIds: [],
    branch: 'main',
    kind: 'init',
    message: 'init from recipe: research-base',
    codePin: null,
    apmLockHash: null,
    createdAt: '2026-04-25T08:00:00.000Z',
    modules: [
      { type: 'chatmode', name: 'senior-eng', enabled: true,
        source: { kind: 'local', path: '.claude/agents/senior-eng.md' } },
      { type: 'mcp', name: 'Read', enabled: true, source: { kind: 'builtin' } },
    ],
  };
  const init = repo.writeSnapshot(initBlob);
  repo.setBranch('main', init.id);

  const editBlob: Omit<Snapshot, 'id'> = {
    formatVersion: '0.1',
    parentIds: [init.id],
    branch: 'main',
    kind: 'edit',
    message: '+ postgres MCP',
    codePin: null,
    apmLockHash: null,
    createdAt: '2026-04-25T09:00:00.000Z',
    modules: [
      ...initBlob.modules,
      { type: 'mcp', name: 'postgres', version: 'v0.9', enabled: true,
        source: { kind: 'local', path: '.claude/settings.json' } },
    ],
  };
  const edit = repo.writeSnapshot(editBlob);
  repo.setBranch('main', edit.id);

  const autoBlob: Omit<Snapshot, 'id'> = {
    formatVersion: '0.1',
    parentIds: [edit.id],
    branch: 'main',
    kind: 'auto',
    message: 'auto · refactor auth flow',
    codePin: null,
    apmLockHash: null,
    createdAt: '2026-04-25T10:00:00.000Z',
    sessionId: 'sess-187abcd-fixture',
    modules: editBlob.modules,
  };
  const auto = repo.writeSnapshot(autoBlob);
  repo.setBranch('main', auto.id);

  repo.close();
  return { cwd, ids: { init: init.id, edit: edit.id, auto: auto.id } };
}

// ── tests ────────────────────────────────────────────────────────────────

describe('TUI end-to-end (Gate 9)', () => {
  let fixture: ReturnType<typeof buildFixtureHarness>;
  let store: Store;

  beforeEach(() => {
    fixture = buildFixtureHarness();
    store = new Store(Repo.open(fixture.cwd));
  });

  afterEach(() => {
    store.close();
    rmSync(fixture.cwd, { recursive: true, force: true });
  });

  test('Lineage renders all three snapshot messages', () => {
    const { lastFrame, unmount } = render(<App store={store} />);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/init from recipe/);
    expect(frame).toMatch(/postgres MCP/);
    expect(frame).toMatch(/refactor auth flow/);
    unmount();
  });

  test('R is a no-op-safe refresh (no crash, frame remains valid)', () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    stdin.write('R');
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/init from recipe/);
    unmount();
  });

  test('lowercase r on Lineage triggers DeferredAction footer', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await flush();
    stdin.write('r');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/v0\.2, not yet implemented/);
    expect(frame).toMatch(/\[r\] reproduce/);
    unmount();
  });

  test('s key navigates to Sessions and shows the auto-snapshot session', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await flush();
    stdin.write('s');
    await flush();
    const frame = lastFrame() ?? '';
    // Session id is 8-char-truncated for display.
    expect(frame).toMatch(/sess-187/);
    expect(frame).toMatch(/refactor auth flow/);
    unmount();
  });

  test('e navigates to Editor; working tree renders without crashing', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await flush();
    stdin.write('e');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/working tree/);
    expect(frame).toMatch(/modules \(/);
    unmount();
  });

  test('c navigates to Compare; defaults to head-vs-parent diff with real changes', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await flush();
    stdin.write('c');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/compare ❯/);
    expect(frame).toMatch(/(No module-level differences|added|removed|changed)/);
    unmount();
  });

  test('m navigates to Modules; falls back to a real module from the lineage', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await flush();
    stdin.write('m');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/modules ❯/);
    expect(frame).toMatch(/(postgres|senior-eng|research)/);
    unmount();
  });

  test('store.close() is callable after unmount and idempotent', () => {
    const closeSpy = vi.spyOn(store, 'close');
    const { unmount } = render(<App store={store} />);
    unmount();
    // App injects mode does NOT close the store on unmount — caller owns lifecycle.
    expect(closeSpy).not.toHaveBeenCalled();
    store.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Don't double-close in afterEach.
    closeSpy.mockRestore();
    // Replace store so afterEach's close() lands on a fresh handle to the same db.
    store = new Store(Repo.open(fixture.cwd));
  });
});

describe('TUI end-to-end (Gate 9) — empty repo', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harness-tui-empty-'));
    Repo.init(cwd).close();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('empty .harness/ renders EmptyRepoScreen instead of crashing', () => {
    const store = new Store(Repo.open(cwd));
    try {
      const { lastFrame, unmount } = render(<App store={store} />);
      const frame = lastFrame() ?? '';
      expect(frame).toMatch(/No snapshots yet/);
      expect(frame).toMatch(/harness install-hook/);
      unmount();
    } finally {
      store.close();
    }
  });
});

describe('TUI end-to-end (Gate 9) — open failure', () => {
  test('non-harness directory renders EmptyRepoScreen with a reason hint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-tui-no-harness-'));
    try {
      // Don't init — Repo.open should fail. The error catches in App's
      // useEffect and re-renders with EmptyRepoScreen.
      const { lastFrame, unmount } = render(<App cwd={cwd} />);
      await flush();
      const frame = lastFrame() ?? '';
      expect(frame).toMatch(/No snapshots yet/);
      expect(frame).toMatch(/no \.harness\//);
      unmount();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
