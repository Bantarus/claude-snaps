import { listSnapshots, readSnapshot } from './blob.js';
import { IntegrityError } from './errors.js';

// All walks below use a Set<string> seen-accumulator to avoid revisiting
// shared ancestors in diamond-shaped DAGs. The compat-fixtures example
// is the regression test for this — a naive walker without seen-set
// visits the init snapshot twice (once via left, once via right).

/**
 * Return all ancestor snapshot ids of `id` (NOT including `id` itself),
 * each visited exactly once. Order is unspecified; callers that need
 * topological order should sort by `createdAt` from the loaded blobs.
 *
 * @throws {IntegrityError} if `id` or any ancestor blob is missing.
 */
export function ancestorsOf(harnessDir: string, id: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  visitParents(harnessDir, id, seen, out, /* includeSelf */ false);
  return out;
}

/**
 * Return all descendant snapshot ids of `id` (NOT including `id` itself),
 * each visited exactly once. Implemented by enumerating all snapshot ids
 * via listSnapshots and selecting those whose ancestor set contains `id`.
 *
 * Cost: O(N) blob loads, O(N²) parent walks in the worst case for a
 * deeply-branching repo. Acceptable for v0.1 (≤ a few hundred snapshots);
 * a forward edge index in lineage.sqlite makes this O(N) when needed.
 */
export function descendantsOf(harnessDir: string, id: string): string[] {
  const all = listSnapshots(harnessDir);
  const out: string[] = [];
  for (const candidate of all) {
    if (candidate === id) continue;
    if (isAncestor(harnessDir, id, candidate)) out.push(candidate);
  }
  return out;
}

/** Is `maybeAncestor` an ancestor of `descendant`? Reflexive is FALSE. */
export function isAncestor(
  harnessDir: string,
  maybeAncestor: string,
  descendant: string,
): boolean {
  if (maybeAncestor === descendant) return false;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const blob = readSnapshot(harnessDir, cur);
    for (const p of blob.parentIds) {
      if (p === maybeAncestor) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

/**
 * Lowest common ancestor of two snapshots. Returns null if they live in
 * disjoint DAGs (no shared ancestor). The "lowest" is the most recent
 * by `createdAt`.
 *
 * Algorithm: collect ancestors of A (including A itself), walk ancestors
 * of B (including B); the first match in B's reverse-topological order
 * by createdAt is the LCA.
 */
export function lcaOf(
  harnessDir: string,
  idA: string,
  idB: string,
): string | null {
  const ancA = new Set([idA, ...ancestorsOf(harnessDir, idA)]);
  const candidates: string[] = [];
  if (ancA.has(idB)) candidates.push(idB);
  for (const id of ancestorsOf(harnessDir, idB)) {
    if (ancA.has(id)) candidates.push(id);
  }
  if (candidates.length === 0) return null;
  // Pick the one with the most recent createdAt (ISO 8601 sorts as text).
  let best = candidates[0]!;
  let bestAt = readSnapshot(harnessDir, best).createdAt;
  for (let i = 1; i < candidates.length; i++) {
    const cur = candidates[i]!;
    const at = readSnapshot(harnessDir, cur).createdAt;
    if (at > bestAt) {
      best = cur;
      bestAt = at;
    }
  }
  return best;
}

// ── private ────────────────────────────────────────────────────────────────

function visitParents(
  harnessDir: string,
  id: string,
  seen: Set<string>,
  out: string[],
  includeSelf: boolean,
): void {
  if (includeSelf) {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  }
  let blob;
  try {
    blob = readSnapshot(harnessDir, id);
  } catch (cause) {
    throw new IntegrityError(`dag walk: missing or unreadable snapshot ${id}`, cause);
  }
  for (const parent of blob.parentIds) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    out.push(parent);
    visitParents(harnessDir, parent, seen, out, /* includeSelf */ false);
  }
}
