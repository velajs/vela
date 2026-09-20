import { describe, expect, it } from 'vitest';
import { VelaError } from '../error';
import { isVelaError } from '../guard';

describe('isVelaError', () => {
  it('accepts a real VelaError and subclasses', () => {
    class StorageQuotaError extends VelaError {}
    expect(isVelaError(new VelaError('conflict'))).toBe(true);
    expect(isVelaError(new StorageQuotaError('too_many_requests'))).toBe(true);
  });

  it('accepts a wire-decoded twin (plain Error carrying copied own props)', () => {
    const original = new VelaError('gone', { message: 'expired' });
    const twin = Object.assign(new Error(original.message), { ...original });
    expect(isVelaError(twin)).toBe(true);
  });

  it('REJECTS a foreign error that merely has code+status (plan-119 regression)', () => {
    const foreign = Object.assign(new Error('internal driver detail: host=10.0.0.5'), {
      code: 'PROTOCOL_ERROR',
      status: 502,
    });
    expect(isVelaError(foreign)).toBe(false);
  });

  it('rejects plain errors, wrong-typed fields, and non-errors', () => {
    expect(isVelaError(new Error('x'))).toBe(false);
    expect(
      isVelaError(Object.assign(new Error('x'), { code: 1, status: 'y', type: 'VelaError' })),
    ).toBe(false);
    expect(isVelaError({ type: 'VelaError', code: 'x', status: 500 })).toBe(false);
    expect(isVelaError(null)).toBe(false);
  });

  it('rejects when only code has the wrong type', () => {
    expect(
      isVelaError(Object.assign(new Error('x'), { code: 1, status: 500, type: 'VelaError' })),
    ).toBe(false);
  });

  it('rejects when only status has the wrong type', () => {
    expect(
      isVelaError(Object.assign(new Error('x'), { code: 'x', status: 'y', type: 'VelaError' })),
    ).toBe(false);
  });
});
