# harness-tui

A React Ink TUI for **agent-harness snapshot lineage** over the Claude
Code project ecosystem (personas, MCPs, skills, hooks, slash commands,
output styles).

The core idea: when an agent runs a session in your project, the
*harness* — i.e. the configuration of which personas/MCPs/skills/hooks/
commands/styles were active and pinned — is captured as an immutable
**Snapshot**. Snapshots form a DAG (lineage) that lives **alongside but
decoupled from** your code's git history. Each snapshot records a
`codePin` (the git sha at the moment) so you can always correlate, but
you can rewind, branch, fork, diff and promote *harnesses* without
touching code.

This means:

- You can **time-travel the agent** independently of the codebase.
- You can **bisect** to find which harness change introduced a regression.
- You can **promote** a working tree to a named version (`v0.5`) the
  same way you tag a release.
- You can **re-run a session** against the exact harness that produced a
  good result two weeks ago — even if both the code and the current
  harness have moved on.

## The 5 screens

| Key | Screen | What it does |
|-----|--------|---|
| `l` | **Lineage**  | Git-style branch graph of snapshots. Lane glyphs (●/◆/├╮), commit ids, version tags, code-pin badges, selected-row preview pane with the full module composition. |
| `s` | **Sessions** | Session detail. Split pane: timestamped trace stream on the left, full harness snapshot + drift-from-current on the right. |
| `c` | **Compare**  | Side-by-side diff between two tagged versions. `+ − ~` markers, tinted row backgrounds, center spine. |
| `e` | **Editor**   | Working-tree editor. ASCII timeline rail above a modules table with `[x]` toggles, plus an uncommitted-changes panel and promote-as form. |
| `m` | **Modules**  | Per-module page. Block-character bar charts for version usage, a Unicode sparkline for the 7-day trend, sessions-using list with ✓/⚠/✗ status glyphs. |

Per-screen keys are listed in the inverse-video status bar at the
bottom. Global: `q` to quit, single letters to jump screens.

## Running

```bash
npm install
npm run dev
```

Resize your terminal to ~100 columns × 36 rows for the layout to
breathe. Press `q` (or `Ctrl-C`) to exit.

## Manual smoke test

After `npm run dev`:

1. App boots on the **Lineage** screen with the sidebar's "Lineage" row
   highlighted.
2. Press `s`/`e`/`m`/`c` to jump to **Sessions**, **Editor**,
   **Modules**, **Compare** — the active sidebar row updates and the
   status-bar key legend changes per screen.
3. Press `l` to return to **Lineage**.
4. Use `↑`/`↓` to move the `❯` cursor on Lineage / Session trace /
   Editor module rows / Modules session list.
5. On **Editor**, press `space` on a row to toggle its `[x]` checkbox.
6. Press `q` (or `Ctrl-C`) to quit cleanly.

For a non-interactive render dump (also handy for screenshotting at a
fixed width), run `npm run render` — it renders all five screens at
`COLUMNS=130` and prints the last frame of each.

## Architecture

```
src/
├── cli.tsx               # ink render entry
├── app.tsx               # screen router + global keys
├── theme.ts              # palette + module-type glyph map
├── types.ts              # Snapshot / Session / WorkingTree
├── data/mock.ts          # mock lineage to drive the demo
├── components/
│   ├── Frame.tsx         # sidebar + content + status bar wrapper
│   ├── Sidebar.tsx       # harness identity, nav, stats
│   ├── StatusBar.tsx     # bottom inverse-video key hints
│   ├── Tabs.tsx          # `[ Tab ]` strip
│   ├── Glyph.tsx         # one-glyph module type indicator
│   ├── Bar.tsx           # block-char horizontal bar
│   └── Sparkline.tsx     # block-char 7-day sparkline
└── screens/
    ├── Lineage.tsx
    ├── Session.tsx
    ├── Diff.tsx
    ├── Editor.tsx
    └── Module.tsx
```

The data layer is currently `data/mock.ts`. To make this real, swap it
for a `Store` interface backed by:

- a JSON file per project (e.g. `.claude/harness-lineage.json`)
- or a small SQLite db
- or a Tauri command into a Rust workspace (the same shape as the
  VCC-Narrative compiler) — snapshots fit naturally into a JSONL
  append-only log keyed by snapshot id.

Snapshots are content-addressable: `id` can be derived from a hash of
`{parentIds, modules, codePin}` so the lineage is verifiable.

## What's NOT implemented yet (the obvious next steps)

- Real persistence (JSONL or SQLite store)
- Actual integration with Claude Code: a hook that auto-snapshots on
  session start, and a slash command (`/harness snapshot`, `/harness
  rewind`) that talks to this TUI's store
- Search (the `Search` tab is a stub)
- Recipes screen (the `r` nav item routes to Lineage for now)
- Bisect interactive mode (the `B` key on Modules is a placeholder)
- Side-by-side / unified diff toggle on the Compare screen

The structure is designed so each of these slots in cleanly without
reshaping the screens.
