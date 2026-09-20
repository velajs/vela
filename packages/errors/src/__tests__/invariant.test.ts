import { describe, expect, it } from 'vitest';
import { invariant, unreachable } from '../invariant';
import { toErrorBody } from '../to-error-body';

describe('invariant/unreachable', () => {
  it('invariant throws an internal-coded VelaError that redacts on the wire', () => {
    let caught: unknown;
    try {
      invariant(false, 'subscription registry out of sync', { subId: 'abc' });
    } catch (err) {
      caught = err;
    }
    const { redacted, body } = toErrorBody(caught);
    expect(redacted).toBe(true);
    expect(body.error.message).not.toContain('registry');
  });

  it('invariant narrows types', () => {
    const value: string | undefined = 'x' as string | undefined;
    invariant(value !== undefined, 'value required');
    expect(value.length).toBe(1); // compiles only if narrowed
  });

  it('unreachable throws', () => {
    expect(() => unreachable('boom' as never)).toThrow();
  });
});
