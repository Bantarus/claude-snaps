import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { T } from '../theme.js';

// Screen-level footer line shown when the user hits a v0.2-deferred
// keybind (pin #1). Auto-clears after 3 seconds. Use `key={label}` at
// the call site so re-pressing the same key remounts and resets the
// timer.
export const DeferredAction: React.FC<{ label: string }> = ({ label }) => {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <Text>
      <Text color={T.cmd} bold>{label}</Text>
      <Text color={T.dim}> — v0.2, not yet implemented</Text>
    </Text>
  );
};
