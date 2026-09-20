import { describe, expect, it } from 'vitest';
import { isVelaError, toErrorBody, VelaError } from '../index';

describe('brand survives serialization', () => {
  const original = new VelaError('conflict', { message: 'rev mismatch', data: { rev: 3 } });

  it('via JSON spread (wire-codec prop copy)', () => {
    const twin = Object.assign(
      new Error(original.message),
      JSON.parse(JSON.stringify({ ...original })),
    );
    expect(isVelaError(twin)).toBe(true);
    expect(toErrorBody(twin).redacted).toBe(false);
  });

  it('via structuredClone (DO RPC analog)', () => {
    const cloned = structuredClone({ ...original });
    const twin = Object.assign(new Error(String(cloned.message ?? original.message)), cloned);
    expect(isVelaError(twin)).toBe(true);
  });
});
