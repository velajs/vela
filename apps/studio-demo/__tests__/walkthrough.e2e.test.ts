import { beforeAll, describe, expect, it } from 'vitest';
import { runWalkthrough } from '../src/walkthrough';
import type { WalkthroughReport } from '../src/walkthrough';

/**
 * The durable conformance gate: boot the whole demo app + the loopback host and
 * drive every Studio operation + the time-travel round-trip + the 428 confirm
 * flows end-to-end. Every recorded op must pass.
 */
describe('Studio demo — end-to-end conformance walkthrough', () => {
  let report: WalkthroughReport;

  beforeAll(async () => {
    report = await runWalkthrough({ token: 'e2e-master-token' });
  });

  it('records a broad op surface (coverage guard)', () => {
    // Guards against a trivially-green run: the walkthrough must exercise the
    // whole product, not a handful of ops.
    expect(report.rows.length).toBeGreaterThanOrEqual(30);
  });

  it('passes every operation, round-trip, and host check', () => {
    const failures = report.rows.filter((r) => !r.pass);
    if (failures.length > 0) {
      // Surface a readable failure table for CI logs.
      // eslint-disable-next-line no-console
      console.error(
        ['FAILED OPS:', ...failures.map((f) => `  ✗ ${f.op} — ${f.detail}`)].join('\n'),
      );
    }
    expect(failures.map((f) => f.op)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
