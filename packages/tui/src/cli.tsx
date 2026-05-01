#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';

// `withFullScreen` would be nicer but ink's stable API is just render().
// This puts the app on stdout. Resize the terminal for best results
// (the TUI assumes ~100 cols × 36 rows).
render(<App />);
