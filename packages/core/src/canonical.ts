import { createHash } from 'node:crypto';
import { IntegrityError } from './errors.js';
import type { Snapshot } from './types.js';

// Canonical JSON per spec/format.md §3.2. The implementation rules
// (verbatim from the spec):
//   1. Sort object keys at every depth via Object.keys(o).sort() —
//      do NOT depend on V8 insertion order.
//   2. No whitespace between tokens. JSON.stringify with no `space`.
//   3. UTF-8 via TextEncoder (not Buffer — semantics drift across runtimes).
//   4. Numbers: integer-only in v0.3 examples. Non-integer throws
//      IntegrityError; RFC 8785 number canonicalization is v0.4.
//   5. Fields enumerated in spec/format.md §3.1 are removed before
//      hashing — destructure, do not mutate. The exclusion list is the
//      composition-defining vs. observation-context split: composition
//      participates in id derivation, observation context does not.
//   6. The 40-char id is the lowercase hex prefix of the full sha256.

const ENCODER = new TextEncoder();

/**
 * Recursively sort object keys lexicographically by UTF-16 code units
 * (matches Array.prototype.sort default). Arrays preserve order;
 * primitives are returned as-is.
 *
 * Intentionally `unknown` in/out: this is a structural transform, not
 * a typed one — the Snapshot shape is enforced by writeSnapshot, not here.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * Produce the canonical UTF-8 byte representation per spec/format.md §3.2.
 * @throws {IntegrityError} on non-integer numeric values.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  assertIntegerNumbers(value);
  const sorted = canonicalize(value);
  // JSON.stringify with no `space` emits the no-whitespace form.
  // TextEncoder produces UTF-8 with no BOM. Together these match Python's
  // json.dumps(obj, sort_keys=True, separators=(',',':'), ensure_ascii=False)
  // for the integer-only domain we use in v0.3.
  return ENCODER.encode(JSON.stringify(sorted));
}

// Fields excluded from canonical bytes per spec/format.md §3.1.
// These are observation context (when/where/how this fire happened),
// not composition (what the harness was at this moment). Stripping
// them ensures two observations of identical composition produce the
// same snapshot id — the load-bearing invariant for trajectory queries
// in §2.7.
const EXCLUDED_FIELDS = ['id', 'createdAt', 'codePin', 'model', 'permissionMode'] as const;

/**
 * Compute the snapshot id: sha256(canonicalBytes(snap \ EXCLUDED_FIELDS))[:40],
 * lowercase hex. EXCLUDED_FIELDS = id, createdAt, codePin, model,
 * permissionMode (spec/format.md §3.1).
 *
 * Accepts a Snapshot with or without those fields; they are destructured
 * out before hashing so the input is never mutated.
 *
 * @throws {IntegrityError} on non-integer numeric values inside the blob.
 */
export function snapshotId(snapshot: Snapshot | Omit<Snapshot, 'id'>): string {
  const stripped: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  for (const key of EXCLUDED_FIELDS) delete stripped[key];
  const bytes = canonicalBytes(stripped);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return digest.slice(0, 40);
}

// ── private ────────────────────────────────────────────────────────────────

function assertIntegerNumbers(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IntegrityError(
        `non-finite numeric value (${String(value)}); JSON spec forbids NaN/Infinity`,
      );
    }
    if (!Number.isInteger(value)) {
      throw new IntegrityError(
        `non-integer numeric value (${String(value)}); RFC 8785 number canonicalization not implemented in v0.3`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertIntegerNumbers(v);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) assertIntegerNumbers(v);
  }
}
