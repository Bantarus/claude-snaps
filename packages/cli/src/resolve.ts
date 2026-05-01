import { InvalidStateError, RefNotFoundError, EmptyRepositoryError, type Repo } from '@harness/core';

const ID_RE = /^[0-9a-f]{40}$/;
const HEX_RE = /^[0-9a-f]+$/;
const MIN_PREFIX = 6;

/**
 * Resolve a user-supplied ref string to a snapshot id.
 *
 * Accepted forms (priority order on collision):
 *   1. Literal 40-char lowercase hex — verified to exist on disk.
 *   2. "HEAD" — `repo.resolveHead()`. Throws EmptyRepositoryError on empty repo.
 *   3. Tag name — `refs/tags/<name>`.
 *   4. Branch name — `refs/heads/<name>`.
 *   5. 6+ char hex prefix — unique snapshot id with that prefix.
 *
 * Hex prefixes shorter than 6 chars are refused (per pinned policy: git's
 * 4-char minimum has been a steady stream of "wait, that wasn't the commit
 * I meant" pain over the years; v0.1 picks 6 for safety, can drop to 4 in
 * v0.2 if needed).
 *
 * @throws {RefNotFoundError} if the ref doesn't match anything.
 * @throws {InvalidStateError} on ambiguous prefix or sub-min-length hex.
 * @throws {EmptyRepositoryError} when "HEAD" resolves on an empty repo.
 */
export function resolveRef(repo: Repo, ref: string): string {
  if (ref.length === 0) throw new InvalidStateError('empty ref');

  // 1. Literal 40-char hex
  if (ID_RE.test(ref)) {
    const allIds = new Set(repo.listSnapshotIds());
    if (!allIds.has(ref)) {
      throw new RefNotFoundError(`no snapshot with id ${ref}`);
    }
    return ref;
  }

  // 2. HEAD
  if (ref === 'HEAD') {
    const id = repo.resolveHead();
    if (id === null) {
      throw new EmptyRepositoryError(
        'HEAD points at a branch with no commits yet (empty repository)',
      );
    }
    return id;
  }

  // 3. Tag
  const tags = repo.tags();
  if (Object.prototype.hasOwnProperty.call(tags, ref)) {
    return tags[ref]!;
  }

  // 4. Branch
  const branches = repo.branches();
  if (Object.prototype.hasOwnProperty.call(branches, ref)) {
    return branches[ref]!;
  }

  // 5. Hex prefix
  if (HEX_RE.test(ref)) {
    if (ref.length < MIN_PREFIX) {
      throw new InvalidStateError(
        `hex prefix '${ref}' is shorter than the v0.1 minimum of ${MIN_PREFIX} chars`,
      );
    }
    const matches = repo.listSnapshotIds().filter((id) => id.startsWith(ref));
    if (matches.length === 0) {
      throw new RefNotFoundError(`no snapshot id starts with prefix '${ref}'`);
    }
    if (matches.length > 1) {
      const sample = matches.slice(0, 4).map((id) => id.slice(0, 12)).join(', ');
      throw new InvalidStateError(
        `ambiguous prefix '${ref}': matches ${matches.length} snapshots (${sample}${matches.length > 4 ? ', ...' : ''})`,
      );
    }
    return matches[0]!;
  }

  throw new RefNotFoundError(`unknown ref '${ref}'`);
}
