import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { Bar } from '../components/Bar.js';
import { Sparkline } from '../components/Sparkline.js';
import { DeferredAction } from '../components/DeferredAction.js';
import { T } from '../theme.js';
import { useStore } from '../context.js';
import { useSnapshots } from '../hooks/useSnapshots.js';
import type { ModuleType } from '../types.js';
import type { Goto } from '../app.js';

interface Props {
  goto: Goto;
  moduleType?: ModuleType;
  moduleName?: string;
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function trunc(s: string, w: number) {
  return s.length <= w ? pad(s, w) : s.slice(0, w - 1) + '…';
}

export const ModulePage: React.FC<Props> = ({ goto, moduleType, moduleName }) => {
  const store = useStore();
  const { snapshots } = useSnapshots();
  const [sel, setSel] = useState(0);
  const [deferred, setDeferred] = useState<string | null>(null);

  // If no module is selected, pick the first non-builtin module from the
  // newest snapshot. Predictable starting point for the screen.
  const fallback = useMemo(() => {
    for (const s of snapshots) {
      const m = s.modules.find((x) => x.type !== 'mcp' || (x.version !== undefined));
      if (m !== undefined) return { type: m.type, name: m.name };
    }
    return null;
  }, [snapshots]);

  const target = moduleType !== undefined && moduleName !== undefined
    ? { type: moduleType, name: moduleName }
    : fallback;

  const data = useMemo(() => {
    if (target === null) return null;
    try {
      return store.moduleData(target.type, target.name);
    } catch {
      return null;
    }
  }, [store, target]);

  useInput((input, key) => {
    if (key.escape) goto('Lineage');
    if (data === null) return;
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow) setSel((i) => Math.min(data.recentSessions.length - 1, i + 1));
    if (input === 'u') setDeferred('[u] update');
    if (input === 'B') setDeferred('[B] bisect');
    if (input === 'c') setDeferred('[c] config');
  });

  if (target === null || data === null) {
    return (
      <Frame
        active="Modules"
        keys={[{ k: 'esc', l: 'back' }]}
        right="modules"
      >
        <Box paddingX={1}>
          <Text color={T.faint}>
            No module selected. Open a module from the Lineage preview, or
            navigate to one once snapshots accumulate.
          </Text>
        </Box>
      </Frame>
    );
  }

  const max = data.versionsUsage.length === 0
    ? 1
    : Math.max(...data.versionsUsage.map((v) => v.n));

  return (
    <Frame
      active="Modules"
      keys={[
        { k: '↑↓', l: 'session' },
        { k: '↵', l: 'open' },
        { k: 'u', l: 'update' },
        { k: 'B', l: 'bisect' },
        { k: 'c', l: 'config' },
        { k: 'esc', l: 'back' },
      ]}
      right={`${data.name}`}
    >
      <Box>
        <Text>
          <Text color={T.dim}>harness ❯ modules ❯ </Text>
          <Glyph type={data.type} />
          <Text> </Text>
          <Text color={T.mcp} bold>{data.name}</Text>
          <Text color={T.dim}>{'   '}{data.type}</Text>
        </Text>
      </Box>

      <Tabs
        tabs={['Overview', 'Sessions', 'Config', 'Versions', 'Source']}
        active="Overview"
      />

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={T.dim}
        paddingX={1}
        marginTop={1}
      >
        <Text color={T.dim}>at a glance</Text>
        <Text>
          <Text color={T.faint}>used in       </Text>
          <Text color={T.fg} bold>{data.totalSessions} sessions</Text>
          <Text>{'    '}</Text>
          <Text color={T.faint}>versions tried</Text>
          <Text> </Text>
          <Text color={T.fg} bold>{data.versionsUsage.length}</Text>
          <Text>{'    '}</Text>
          <Text color={T.faint}>config shapes </Text>
          <Text color={T.fg} bold>{data.configShapes.length}</Text>
        </Text>
        <Text>
          <Text color={T.faint}>last 7d   </Text>
          <Sparkline values={data.trendDays} />
          <Text>{'   '}</Text>
          <Text color={T.faint}>· ({data.trendDays.reduce((a, b) => a + b, 0)} snapshots)</Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="row" gap={1} flexGrow={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="42%"
          flexShrink={1}
        >
          <Text color={T.dim}>version usage</Text>
          {data.versionsUsage.length === 0 ? (
            <Text color={T.faint}>(none)</Text>
          ) : data.versionsUsage.map((v) => (
            <Box flexDirection="column" key={v.v}>
              <Text>
                <Text color={v.cur ? T.persona : T.fg} bold>
                  {pad(v.v, 12)}
                </Text>
                <Bar value={v.n} max={max} width={14} color={v.old ? T.faint : T.mcp} />
                <Text> </Text>
                <Text color={T.fg} bold>{String(v.n).padStart(2)}</Text>
              </Text>
              {v.note !== '' && <Text color={T.faint}>     {v.note}</Text>}
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color={T.faint}>config shapes tried</Text>
          </Box>
          {data.configShapes.length === 0 ? (
            <Text color={T.faint}>(none)</Text>
          ) : data.configShapes.map((c) => (
            <Text key={c.label}>
              <Text color={T.fg}>{trunc(c.label, 22)}</Text>
              <Text color={T.faint}>({c.count})</Text>
            </Text>
          ))}
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="56%"
          flexShrink={1}
        >
          <Text color={T.dim}>sessions that used this</Text>
          {data.recentSessions.length === 0 ? (
            <Text color={T.faint}>(no auto-snapshots reference this module yet)</Text>
          ) : data.recentSessions.map((s, i) => {
            const isSel = i === sel;
            const okColor =
              s.status === 'ok' ? T.persona : s.status === 'warn' ? T.hook : T.rm;
            const okGlyph =
              s.status === 'ok' ? '✓' : s.status === 'warn' ? '⚠' : '✗';
            return (
              <Text key={i} backgroundColor={isSel ? '#1c1f25' : undefined}>
                {isSel ? <Text color={T.sel} bold>❯</Text> : <Text> </Text>}
                <Text color={T.faint}> {pad(s.age, 4)}</Text>
                <Text color={okColor} bold>{okGlyph}</Text>
                <Text color={T.fg} bold> {trunc(s.message, 22)}</Text>
                <Text backgroundColor={T.hook} color={T.selFg} bold> {s.harness} </Text>
                <Text>{'  '}</Text>
                <Text color={T.faint}>{s.moduleVer}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>

      {deferred !== null && <DeferredAction key={deferred + '-' + Date.now()} label={deferred} />}
    </Frame>
  );
};
