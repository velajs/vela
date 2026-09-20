/**
 * The protocol conformance runner. Both wire endpoints run this in their own
 * test suites (see `@velajs/testing`'s live harness) so a codec that drifts
 * from the golden fixtures — or from the shared delta semantics — fails a test
 * on the offending side.
 *
 * Checks, in order:
 * 1. Frame encoding: `encodeLiveEnvelope(fixture.frame)` is byte-identical to
 *    the pinned wire string, the wire parses back to a guard-recognized frame,
 *    and `readLiveEnvelope` extracts it.
 * 2. Delta fixtures: the codec's `encodeListDelta` produces exactly the pinned
 *    ops (or bails where the fixture says it must), and for every mergeable
 *    fixture `applyListDelta` reconstructs `next` exactly — then reapplying
 *    the same ops changes nothing (at-least-once replay idempotency).
 * 3. A seeded randomized sweep of generated list pairs asserting the
 *    exact-reconstruction property on cases the fixtures don't enumerate.
 */

import { DEFAULT_KEY_FIELD, applyListDelta, encodeListDelta } from './delta';
import {
  encodeLiveEnvelope,
  isClientLiveFrame,
  isServerLiveFrame,
  readLiveEnvelope,
} from './frames';
import type { RowOp } from './frames';
import { DELTA_FIXTURES, FRAME_FIXTURES } from './fixtures';

/** The two halves a wire endpoint must implement compatibly. */
export interface DeltaCodec {
  encodeListDelta: (previous: unknown, next: unknown, keyField?: string) => RowOp[] | undefined;
  applyListDelta: (
    current: unknown,
    ops: readonly RowOp[],
    keyField?: string,
  ) => unknown[] | undefined;
}

const REFERENCE_CODEC: DeltaCodec = { encodeListDelta, applyListDelta };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
};

/** Deterministic LCG so the randomized sweep is reproducible (no Math.random). */
const makeRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

interface GeneratedCase {
  previous: Record<string, unknown>[];
  next: Record<string, unknown>[];
}

/**
 * Generate a mergeable previous/next pair: start from a random keyed list,
 * then delete a random subset, update random payloads, and insert fresh keys
 * at random positions. Survivor order is preserved by construction, so every
 * generated case is expressible as a delta.
 */
const generateCase = (random: () => number, caseIndex: number): GeneratedCase => {
  const previousLength = Math.floor(random() * 8);
  const previous: Record<string, unknown>[] = [];
  for (let index = 0; index < previousLength; index += 1) {
    previous.push({ id: `k${caseIndex}-${index}`, n: Math.floor(random() * 100) });
  }

  const next: Record<string, unknown>[] = [];
  for (const row of previous) {
    if (random() < 0.25) continue; // delete
    next.push(random() < 0.4 ? { ...row, n: Math.floor(random() * 100) } : row);
  }
  const insertions = Math.floor(random() * 4);
  for (let index = 0; index < insertions; index += 1) {
    const position = Math.floor(random() * (next.length + 1));
    next.splice(position, 0, { id: `f${caseIndex}-${index}`, n: Math.floor(random() * 100) });
  }

  return { previous, next };
};

export interface ConformanceReport {
  /** Human-readable failure descriptions; empty = conformant. */
  failures: string[];
  checks: number;
}

/**
 * Run the full conformance suite against a codec (defaults to the reference
 * codec in this package — the package's own tests run exactly this).
 */
export const runProtocolConformance = (codec: DeltaCodec = REFERENCE_CODEC): ConformanceReport => {
  const failures: string[] = [];
  let checks = 0;

  for (const fixture of FRAME_FIXTURES) {
    checks += 1;
    const encoded = encodeLiveEnvelope(fixture.frame);
    if (encoded !== fixture.wire) {
      failures.push(
        `frame "${fixture.name}": encoded wire differs\n  expected ${fixture.wire}\n  actual   ${encoded}`,
      );
      continue;
    }
    const envelope: unknown = JSON.parse(fixture.wire);
    const frame = readLiveEnvelope(envelope);
    if (frame === undefined) {
      failures.push(`frame "${fixture.name}": readLiveEnvelope did not recognize the envelope`);
      continue;
    }
    if (!isClientLiveFrame(frame) && !isServerLiveFrame(frame)) {
      failures.push(`frame "${fixture.name}": decoded frame not recognized by either guard`);
    }
  }

  for (const fixture of DELTA_FIXTURES) {
    checks += 1;
    const keyField = fixture.keyField ?? DEFAULT_KEY_FIELD;
    const ops = codec.encodeListDelta(fixture.previous, fixture.next, keyField);

    if (fixture.expected === null) {
      if (ops !== undefined) {
        failures.push(
          `delta "${fixture.name}": expected bail-to-snapshot, got ${JSON.stringify(ops)}`,
        );
      }
      continue;
    }

    if (ops === undefined) {
      failures.push(
        `delta "${fixture.name}": encoder bailed, expected ${JSON.stringify(fixture.expected)}`,
      );
      continue;
    }
    if (!deepEqual(ops, fixture.expected)) {
      failures.push(
        `delta "${fixture.name}": ops differ\n  expected ${JSON.stringify(fixture.expected)}\n  actual   ${JSON.stringify(ops)}`,
      );
      continue;
    }

    const merged = codec.applyListDelta(fixture.previous, ops, keyField);
    if (merged === undefined || !deepEqual(merged, fixture.next)) {
      failures.push(
        `delta "${fixture.name}": apply(previous, ops) did not reconstruct next\n  expected ${JSON.stringify(fixture.next)}\n  actual   ${JSON.stringify(merged)}`,
      );
      continue;
    }

    const replayed = codec.applyListDelta(merged, ops, keyField);
    if (replayed === undefined || !deepEqual(replayed, fixture.next)) {
      failures.push(`delta "${fixture.name}": replaying the same ops was not idempotent`);
    }
  }

  const random = makeRandom(0x5eed);
  for (let caseIndex = 0; caseIndex < 250; caseIndex += 1) {
    checks += 1;
    const { previous, next } = generateCase(random, caseIndex);
    const ops = codec.encodeListDelta(previous, next);

    if (ops === undefined) {
      failures.push(`random #${caseIndex}: codec bailed on an expressible list change`);
      continue;
    }

    const merged = codec.applyListDelta(previous, ops);
    if (merged === undefined || !deepEqual(merged, next)) {
      failures.push(
        `random #${caseIndex}: apply(previous, ops) != next\n  previous ${JSON.stringify(previous)}\n  next     ${JSON.stringify(next)}\n  ops      ${JSON.stringify(ops)}\n  merged   ${JSON.stringify(merged)}`,
      );
    }
  }

  return { failures, checks };
};
