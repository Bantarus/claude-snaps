import React from 'react';
import { Text } from 'ink';
import { T } from '../theme.js';

const LADDER = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export const Sparkline: React.FC<{
  values: number[];
  highlightLast?: boolean;
}> = ({ values, highlightLast = true }) => {
  const max = Math.max(...values, 1);
  return (
    <Text>
      {values.map((v, i) => {
        const idx = Math.max(0, Math.min(LADDER.length - 1, Math.round((v / max) * (LADDER.length - 1))));
        const isLast = i === values.length - 1;
        const colour =
          isLast && highlightLast
            ? T.persona
            : i >= values.length - 2
              ? T.fg
              : i >= values.length - 4
                ? T.dim
                : T.faint;
        return (
          <Text key={i} color={colour}>
            {LADDER[idx]}
          </Text>
        );
      })}
    </Text>
  );
};
