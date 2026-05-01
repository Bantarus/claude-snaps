// Public exception hierarchy. Internal calls throw; CLI/TUI/hook
// consumers catch at their top level and translate per spec.

export class HarnessError extends Error {
  override readonly name: string;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Filesystem failure: read/write/rename/fsync. */
export class IoError extends HarnessError {}

/** Malformed input: JSON parse, YAML parse, JSON Schema mismatch on read. */
export class ParseError extends HarnessError {}

/** Hash mismatch, ref pointing at a missing blob, schema drift. */
export class IntegrityError extends HarnessError {}

/** Tag or branch ref not found on disk. */
export class RefNotFoundError extends HarnessError {}

/** Operation requires a commit; the repository has none yet. */
export class EmptyRepositoryError extends HarnessError {}

/** API misuse — e.g. writing on a detached HEAD without explicit opt-in. */
export class InvalidStateError extends HarnessError {}
