import { sourcesEqual, type Module } from '@harness/core';

// Render a one-line summary of what differs between two same-identity
// (type, name) Module objects. Returned text slots between the module
// name and the trailing dim '(changed)' suffix in `harness diff` output.
//
// Output shapes:
//   ''                        — same (caller shouldn't invoke us, but safe)
//   'v0.4 → v0.5'             — version drift only
//   '(configHash)'            — file content edit; version unchanged
//   '(disabled)' / '(enabled)' — enabled flag flipped (new state)
//   '(source)'                — provenance change
//   'v0.4 → v0.5  (configHash, source)' — combined
//
// Order inside parens: state-flip → configHash → source. Stable
// across calls so test assertions match.
//
// `?` literally never appears. If a side has no version but the other
// does, the missing side renders as 'none'.
export function renderChangedAttrs(before: Module, after: Module): string {
  const parts: string[] = [];

  if (before.version !== after.version) {
    const vb = before.version ?? 'none';
    const va = after.version ?? 'none';
    parts.push(`${vb} → ${va}`);
  }

  const attrs: string[] = [];
  if (before.enabled !== after.enabled) {
    attrs.push(after.enabled ? 'enabled' : 'disabled');
  }
  if (before.configHash !== after.configHash) {
    attrs.push('configHash');
  }
  if (!sourcesEqual(before.source, after.source)) {
    attrs.push('source');
  }
  if (attrs.length > 0) {
    parts.push(`(${attrs.join(', ')})`);
  }

  return parts.join('  ');
}
