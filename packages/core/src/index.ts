// Public API for @harness/core. Per spec/format.md design intent and
// the prompt B1 brief: keep this surface small; refactor internals freely.
//
// The `Repo` class is the contract — everything else is an implementation
// detail. canonicalize/canonicalBytes/snapshotId are exported so consumers
// can compute ids without instantiating a Repo (e.g. in dry-run hooks).

export type {
  Module,
  ModuleSource,
  ModuleType,
  Snapshot,
  SnapshotKind,
  Attribution,
  AttributionEventKind,
  DiffOp,
  HeadState,
  ReproduceOptions,
  ReproducePhase,
  ReproduceResult,
  TurnRecord,
  SessionCostSummary,
  IngestSessionOptions,
  IngestSessionResult,
} from './types.js';

export {
  HarnessError,
  IoError,
  ParseError,
  IntegrityError,
  RefNotFoundError,
  EmptyRepositoryError,
  InvalidStateError,
} from './errors.js';

export { canonicalize, canonicalBytes, snapshotId } from './canonical.js';

export { captureCurrentState, captureCurrentStateFast, readClaudeCodeVersion } from './capture.js';

export { Repo } from './repo.js';
export type { RepoInitOptions } from './repo.js';

export { parseTranscriptJsonl, parseTranscriptText, encodeProjectDir } from './ingest.js';

export { diff, summarizeDiff, sourcesEqual } from './diff.js';

export type { ListSnapshotsFilter, ReindexResult } from './index_db.js';
