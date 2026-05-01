#!/usr/bin/env node
import React from 'react';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { render } from 'ink';
import { App } from './app.js';

// Walk up from process.cwd() looking for the nearest `.harness/` —
// matches git's behavior so the TUI can be launched from any
// subdirectory of a harness project. Falls back to cwd if not found,
// which lets App's open-failure path render the EmptyRepoScreen with
// a hint instead of silently looking in the wrong place.
function findHarnessRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    if (existsSync(resolve(dir, '.harness'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// `withFullScreen` would be nicer but ink's stable API is just render().
// This puts the app on stdout. Resize the terminal for best results
// (the TUI assumes ~100 cols × 36 rows).
render(<App cwd={findHarnessRoot(process.cwd())} />);
