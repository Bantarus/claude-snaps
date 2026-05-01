import React from 'react';
import { Text } from 'ink';
import { GLYPHS, glyphColor } from '../theme.js';
import type { ModuleType } from '../types.js';

export const Glyph: React.FC<{ type: ModuleType | string; bold?: boolean }> = ({
  type,
  bold = true,
}) => {
  const g = GLYPHS[type] ?? '•';
  return (
    <Text color={glyphColor(type)} bold={bold}>
      {g}
    </Text>
  );
};
