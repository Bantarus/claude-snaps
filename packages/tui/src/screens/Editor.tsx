import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Frame } from '../components/Frame.js';
import { Tabs } from '../components/Tabs.js';
import { Glyph } from '../components/Glyph.js';
import { T } from '../theme.js';
import { workingTree } from '../data/mock.js';
import type { ScreenName } from '../app.js';

interface Props {
  goto: (s: ScreenName, payload?: unknown) => void;
}

function pad(s: string, w: number) {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

const stateBg = (s: 'same' | 'changed' | 'draft') => {
  if (s === 'draft') return '#2a1f15';
  if (s === 'changed') return '#2a2516';
  return undefined;
};

const stateMark = (s: 'same' | 'changed' | 'draft') => {
  if (s === 'draft')
    return (
      <Text color={T.cmd} bold>
        ★
      </Text>
    );
  if (s === 'changed')
    return (
      <Text color={T.chg} bold>
        ~
      </Text>
    );
  return <Text color={T.faint}>·</Text>;
};

const Timeline: React.FC = () => {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={T.faint}>v0.1     v0.2     v0.3     </Text>
        <Text color={T.fg} bold>
          v0.4{'     '}
        </Text>
        <Text color={T.cmd} bold>
          draft
        </Text>
      </Text>
      <Text>
        <Text color={T.persona} bold>●</Text>
        <Text color={T.line}>───</Text>
        <Text color={T.persona} bold>●</Text>
        <Text color={T.line}>───</Text>
        <Text color={T.persona} bold>●</Text>
        <Text color={T.line}>───</Text>
        <Text color={T.hook} bold>◆</Text>
        <Text color={T.line}>───</Text>
        <Text color={T.cmd} bold>◇</Text>
        <Text color={T.faint}>{'  ← you are here'}</Text>
      </Text>
      <Text color={T.faint}>300      320      350      4a1      (uncommitted)</Text>
    </Box>
  );
};

export const Editor: React.FC<Props> = ({ goto }) => {
  const [sel, setSel] = useState(4); // start on the first draft row
  const [toggles, setToggles] = useState<boolean[]>(
    workingTree.modules.map((m) => m.enabled ?? true),
  );

  useInput((input, key) => {
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    if (key.downArrow)
      setSel((i) => Math.min(workingTree.modules.length - 1, i + 1));
    if (input === ' ') {
      setToggles((t) => t.map((v, i) => (i === sel ? !v : v)));
    }
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
      right={`working tree · ${workingTree.changes.length} changes`}
    >
      <Box>
        <Text>
          <Text color={T.dim}>research-bot ❯ editor ❯ </Text>
          <Text color={T.fg} bold>
            working tree
          </Text>
          <Text color={T.dim}>{'   based on '}</Text>
          <Text color={T.hook} bold>
            v0.4
          </Text>
          <Text>{'   '}</Text>
          <Text color={T.cmd} bold>
            ● {workingTree.changes.length} uncommitted
          </Text>
        </Text>
      </Box>

      <Tabs
        tabs={['Modules', 'Timeline', 'Yaml', 'Recipe']}
        active="Modules"
      />

      <Box marginTop={1}>
        <Timeline />
      </Box>

      <Box marginTop={1} flexDirection="row" gap={1} flexGrow={1}>
        {/* MODULES TABLE */}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={T.dim}
          paddingX={1}
          flexBasis="62%"
          flexShrink={1}
        >
          <Text color={T.dim}>
            modules ({workingTree.modules.length})
          </Text>
          {workingTree.modules.map((m, i) => {
            const isSel = i === sel;
            const on = toggles[i] ?? true;
            const label =
              m.state === 'draft' ? 'draft' : m.state === 'changed' ? 'edit' : 'base';
            return (
              <Box key={m.name + i}>
                <Text backgroundColor={isSel ? '#1c1f25' : stateBg(m.state)}>
                  <Text>
                    {isSel ? (
                      <Text color={T.sel} bold>
                        ❯
                      </Text>
                    ) : (
                      <Text> </Text>
                    )}
                    <Text> </Text>
                    {stateMark(m.state)}
                    <Text> </Text>
                    <Text>[</Text>
                    {on ? (
                      <Text color={T.persona} bold>
                        x
                      </Text>
                    ) : (
                      <Text> </Text>
                    )}
                    <Text>] </Text>
                    <Glyph type={m.type} />
                    <Text> </Text>
                    <Text color={T.fg} bold>
                      {pad(m.name, 13)}
                    </Text>
                    <Text color={T.faint}>
                      {pad(m.version ?? '', 5)}
                    </Text>
                    <Text color={T.faint}>{label}</Text>
                  </Text>
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* UNCOMMITTED + PROMOTE */}
        <Box flexDirection="column" flexBasis="36%" flexShrink={1}>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={T.dim}
            paddingX={1}
          >
            <Text color={T.dim}>uncommitted</Text>
            {workingTree.changes.map((c, i) => (
              <Text key={i}>
                {c.kind === 'add' && (
                  <Text color={T.add} bold>
                    +{' '}
                  </Text>
                )}
                {c.kind === 'remove' && (
                  <Text color={T.rm} bold>
                    −{' '}
                  </Text>
                )}
                {c.kind === 'change' && (
                  <Text color={T.chg} bold>
                    ~{' '}
                  </Text>
                )}
                <Text color={T.fg}>
                  {c.module.type} · {c.module.name}
                  {c.module.version ? ' ' + c.module.version : ''}
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
            <Text color={T.dim}>promote as</Text>
            <Text>
              <Text backgroundColor={T.sel} color={T.selFg} bold>
                {' v0.5 '}
              </Text>
              <Text> </Text>
              <Text color={T.fg}>"+ vec, code-review"</Text>
            </Text>
            <Text>
              <Text color={T.faint}>tag    </Text>
              <Text color={T.fg}>[ ] minor</Text>
            </Text>
            <Text>
              <Text color={T.faint}>       </Text>
              <Text color={T.fg}>[x] major</Text>
            </Text>
            <Text> </Text>
            <Text backgroundColor={T.persona} color={T.selFg} bold>
              {' [⏎] snapshot v0.5 '}
            </Text>
            <Text> </Text>
            <Text backgroundColor={T.line} color={T.fg}>
              {' [ctrl-z] discard '}
            </Text>
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
            <Text color={T.faint}>sessions started after this</Text>
            <Text color={T.faint}>will pin v0.5.</Text>
          </Box>
        </Box>
      </Box>
    </Frame>
  );
};
