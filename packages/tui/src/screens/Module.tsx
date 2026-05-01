import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { Bar } from '../components/Bar.js';
import { Sparkline } from '../components/Sparkline.js';
import { T } from '../theme.js';
import { githubModule } from '../data/mock.js';
import type { ScreenName } from '../app.js';

interface Props {
  goto: (s: ScreenName, payload?: unknown) => void;
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export const ModulePage: React.FC<Props> = ({ goto }) => {
  const [sel, setSel] = useState(3);
  useInput((_, key) => {
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow)
      setSel((i) => Math.min(githubModule.recentSessions.length - 1, i + 1));
    if (key.escape) goto('Lineage');
  });

  const max = Math.max(...githubModule.versionsUsage.map((v) => v.n));

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
      right={`${githubModule.name} · v1.6`}
    >
      <Box>
        <Text>
          <Text color={T.dim}>research-bot ❯ modules ❯ </Text>
          <Glyph type={githubModule.type} />
          <Text> </Text>
          <Text color={T.mcp} bold>
            {githubModule.name}
          </Text>
          <Text color={T.dim}>{'   '}mcp · official</Text>
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
          <Text color={T.fg} bold>
            24 sessions
          </Text>
          <Text>{'    '}</Text>
          <Text color={T.faint}>versions tried</Text>
          <Text> </Text>
          <Text color={T.fg} bold>
            3
          </Text>
          <Text>{'    '}</Text>
          <Text color={T.faint}>last failure  </Text>
          <Text color={T.rm} bold>
            5d ago
          </Text>
        </Text>
        <Text>
          <Text color={T.faint}>last 7d   </Text>
          <Sparkline values={githubModule.trendDays} />
          <Text>{'   '}</Text>
          <Text color={T.faint}>· trending </Text>
          <Text color={T.persona} bold>
            ↑
          </Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="row" gap={1} flexGrow={1}>
        {/* version usage chart */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="42%"
          flexShrink={1}
        >
          <Text color={T.dim}>version usage</Text>
          {githubModule.versionsUsage.map((v) => (
            <Box flexDirection="column" key={v.v}>
              <Text>
                <Text color={v.cur ? T.persona : T.fg} bold>
                  {pad(v.v, 5)}
                </Text>
                <Bar
                  value={v.n}
                  max={max}
                  width={14}
                  color={v.old ? T.faint : T.mcp}
                />
                <Text> </Text>
                <Text color={T.fg} bold>
                  {String(v.n).padStart(2)}
                </Text>
              </Text>
              <Text color={T.faint}>     {v.note}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text color={T.faint}>config shapes tried</Text>
          </Box>
          {githubModule.configShapes.map((c) => (
            <Text key={c.label}>
              <Text color={T.fg}>{pad(c.label, 22)}</Text>
              <Text color={T.faint}>({c.count})</Text>
            </Text>
          ))}
        </Box>

        {/* sessions list */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="56%"
          flexShrink={1}
        >
          <Text color={T.dim}>sessions that used this</Text>
          {githubModule.recentSessions.map((s, i) => {
            const isSel = i === sel;
            const okColor =
              s.status === 'ok'
                ? T.persona
                : s.status === 'warn'
                  ? T.hook
                  : T.rm;
            const okGlyph =
              s.status === 'ok' ? '✓' : s.status === 'warn' ? '⚠' : '✗';
            const harnessBg = s.harness === 'exp' ? T.skill : T.hook;
            return (
              <Text key={i} backgroundColor={isSel ? '#1c1f25' : undefined}>
                {isSel ? (
                  <Text color={T.sel} bold>
                    ❯
                  </Text>
                ) : (
                  <Text> </Text>
                )}
                <Text color={T.faint}> {pad(s.age, 4)}</Text>
                <Text color={okColor} bold>
                  {okGlyph}
                </Text>
                <Text color={T.fg} bold>
                  {' '}
                  {pad(s.message, 22)}
                </Text>
                <Text backgroundColor={harnessBg} color={T.selFg} bold>
                  {' '}
                  {s.harness}{' '}
                </Text>
                <Text>{'  '}</Text>
                <Text color={T.faint}>{s.moduleVer}</Text>
              </Text>
            );
          })}
          <Text>
            <Text color={T.faint}>bisect: </Text>
            <Text color={T.rm} bold>
              ✗
            </Text>
            <Text color={T.faint}> session points to v1.2 → v1.4 regression</Text>
          </Text>
          <Text>
            <Text backgroundColor={T.persona} color={T.selFg} bold>
              {' [u] update v1.6 '}
            </Text>
            <Text> </Text>
            <Text backgroundColor={T.line} color={T.fg}>
              {' [B] bisect '}
            </Text>
            <Text> </Text>
            <Text backgroundColor={T.line} color={T.fg}>
              {' [c] config '}
            </Text>
          </Text>
        </Box>
      </Box>
    </Frame>
  );
};
