import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { DeferredAction } from '../components/DeferredAction.js';
import { T } from '../theme.js';
import { useWorkingTree } from '../hooks/useWorkingTree.js';
import type { Goto } from '../app.js';

interface Props { goto: Goto }

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

const stateBg = (s: 'same' | 'changed' | 'draft') => {
  if (s === 'draft')   return '#2a1f15';
  if (s === 'changed') return '#2a2516';
  return undefined;
};

const stateMark = (s: 'same' | 'changed' | 'draft') => {
  if (s === 'draft')   return <Text color={T.cmd} bold>★</Text>;
  if (s === 'changed') return <Text color={T.chg} bold>~</Text>;
  return <Text color={T.faint}>·</Text>;
};

export const Editor: React.FC<Props> = ({ goto }) => {
  const { tree } = useWorkingTree();
  // The list-selection cursor must clamp to current modules length so it
  // survives a refresh that shrinks the list.
  const [sel, setSel] = useState(0);
  const [toggles, setToggles] = useState<boolean[]>(
    () => tree.modules.map((m) => m.enabled ?? true),
  );
  const [deferred, setDeferred] = useState<string | null>(null);

  // Resync local view-state when the underlying tree changes (e.g. after
  // a refresh hits a new module list). Toggle state intentionally resets —
  // it's display-only per pin #1, no truth lives in the screen.
  React.useEffect(() => {
    setToggles(tree.modules.map((m) => m.enabled ?? true));
    setSel((i) => Math.min(i, Math.max(0, tree.modules.length - 1)));
  }, [tree]);

  useInput((input, key) => {
    if (tree.modules.length === 0) {
      if (key.escape) goto('Lineage');
      return;
    }
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow) setSel((i) => Math.min(tree.modules.length - 1, i + 1));
    if (input === ' ') {
      // Display-only toggle (pin #1).
      setToggles((t) => t.map((v, i) => (i === sel ? !v : v)));
    }
    if (key.return) setDeferred('[⏎] snapshot');
    if (input === 'a') setDeferred('[a] add');
    if (input === 'd') setDeferred('[d] remove');
    if (key.escape) goto('Lineage');
  });

  return (
    <Frame
      active="Editor"
      keys={[
        { k: '↑↓', l: 'select' },
        { k: 'space', l: 'toggle' },
        { k: 'a', l: 'add' },
        { k: 'd', l: 'remove' },
        { k: '⏎', l: 'snapshot' },
        { k: 'esc', l: 'back' },
      ]}
      right={`working tree · ${tree.changes.length} changes`}
    >
      <Box>
        <Text>
          <Text color={T.dim}>harness ❯ editor ❯ </Text>
          <Text color={T.fg} bold>working tree</Text>
          <Text color={T.dim}>{'   based on '}</Text>
          <Text color={T.hook} bold>{tree.baseSnapshotId}</Text>
          {tree.changes.length > 0 && (
            <>
              <Text>{'   '}</Text>
              <Text color={T.cmd} bold>● {tree.changes.length} uncommitted</Text>
            </>
          )}
        </Text>
      </Box>

      <Tabs
        tabs={['Modules', 'Timeline', 'Yaml', 'Recipe']}
        active="Modules"
      />

      <Box marginTop={1} flexDirection="row" gap={1} flexGrow={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="62%"
          flexShrink={1}
        >
          <Text color={T.dim}>modules ({tree.modules.length})</Text>
          {tree.modules.length === 0 ? (
            <Text color={T.faint}>(no modules captured under .claude/)</Text>
          ) : tree.modules.map((m, i) => {
            const isSel = i === sel;
            const on = toggles[i] ?? true;
            const label =
              m.state === 'draft' ? 'draft'
              : m.state === 'changed' ? 'edit'
              : 'base';
            return (
              <Box key={m.type + ':' + m.name}>
                <Text backgroundColor={isSel ? '#1c1f25' : stateBg(m.state)}>
                  <Text>
                    {isSel ? <Text color={T.sel} bold>❯</Text> : <Text> </Text>}
                    <Text> </Text>
                    {stateMark(m.state)}
                    <Text> </Text>
                    <Text>[</Text>
                    {on ? <Text color={T.persona} bold>x</Text> : <Text> </Text>}
                    <Text>] </Text>
                    <Glyph type={m.type} />
                    <Text> </Text>
                    <Text color={T.fg} bold>{pad(m.name, 18)}</Text>
                    <Text color={T.faint}>{pad(m.version ?? '', 7)}</Text>
                    <Text color={T.faint}>{label}</Text>
                  </Text>
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column" flexBasis="36%" flexShrink={1}>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={T.dim}
            paddingX={1}
          >
            <Text color={T.dim}>uncommitted</Text>
            {tree.changes.length === 0 ? (
              <Text color={T.faint}>(working tree matches HEAD)</Text>
            ) : tree.changes.map((c, i) => (
              <Text key={i}>
                {c.kind === 'add'    && <Text color={T.add} bold>+ </Text>}
                {c.kind === 'remove' && <Text color={T.rm}  bold>− </Text>}
                {c.kind === 'change' && <Text color={T.chg} bold>~ </Text>}
                <Text color={T.fg}>
                  {c.module.type} · {c.module.name}
                  {c.module.version !== undefined ? ' ' + c.module.version : ''}
                </Text>
              </Text>
            ))}
          </Box>

          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={T.dim}
            paddingX={1}
            marginTop={1}
          >
            <Text color={T.dim}>note</Text>
            <Text color={T.faint}>snapshots are immutable.</Text>
            <Text color={T.faint}>create new ones via the hook</Text>
            <Text color={T.faint}>or `harness` CLI in v0.1.</Text>
          </Box>
        </Box>
      </Box>

      {deferred !== null && <DeferredAction key={deferred + '-' + Date.now()} label={deferred} />}
    </Frame>
  );
};
