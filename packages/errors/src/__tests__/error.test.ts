import { describe, expect, it } from 'vitest';
import { VelaError } from '../error';

describe('VelaError', () => {
  it('defaults status/hint from the core catalog for core codes', () => {
    const err = new VelaError('not_found');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBeTruthy();
  });

  it('accepts open codes with explicit status', () => {
    const err = new VelaError('order_expired', { status: 410, message: 'Order expired' });
    expect(err.status).toBe(410);
    expect(err.code).toBe('order_expired');
  });

  it('carries every field as an OWN ENUMERABLE property (wire-codec contract)', () => {
    const err = new VelaError('conflict', {
      hint: 'Retry with the latest revision.',
      data: { id: 1 },
    });
    const keys = Object.keys(err);
    for (const k of ['type', 'code', 'status', 'hint', 'data']) expect(keys).toContain(k);
    const twin = JSON.parse(JSON.stringify({ ...err }));
    expect(twin.type).toBe('VelaError');
    expect(twin.code).toBe('conflict');
    expect(twin.status).toBe(409);
  });

  it('supports cause', () => {
    const cause = new Error('db down');
    const err = new VelaError('internal', { cause });
    expect(err.cause).toBe(cause);
  });
});
