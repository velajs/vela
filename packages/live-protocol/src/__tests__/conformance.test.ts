import { describe, expect, it } from 'vitest';

import { runProtocolConformance } from '../conformance';
import { applyListDelta, encodeListDelta } from '../delta';

describe('protocol conformance (reference codec)', () => {
  it('passes its own golden fixtures and randomized sweep', () => {
    const report = runProtocolConformance();
    expect(report.failures).toEqual([]);
    expect(report.checks).toBeGreaterThan(250);
  });

  it('catches a drifting codec', () => {
    const report = runProtocolConformance({
      // A codec that "forgets" the delete-first rule by dropping deletes entirely.
      encodeListDelta: (previous, next, keyField) =>
        encodeListDelta(previous, next, keyField)?.filter((op) => op.op !== 'delete'),
      applyListDelta,
    });
    expect(report.failures.length).toBeGreaterThan(0);
  });
});
