import React from 'react';
import { Text } from 'ink';

// Render an integer-fraction bar using Unicode block elements.
// width is in cells. value/max maps to filled cells.
export const Bar: React.FC<{
  value: number;
  max: number;
  width?: number;
  color?: string;
  bgColor?: string;
}> = ({ value, max, width = 18, color = 'white', bgColor }) => {
  const filled = Math.max(0, Math.min(width, (value / max) * width));
  const full = Math.floor(filled);
  const frac = filled - full;
  const partials = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const idx = Math.round(frac * 7);
  const partial = partials[idx] ?? '';
  const empty = ' '.repeat(Math.max(0, width - full - (partial ? 1 : 0)));
  return (
    <Text color={color} backgroundColor={bgColor}>
      {'█'.repeat(full)}
      {partial}
      {empty}
    </Text>
  );
};
