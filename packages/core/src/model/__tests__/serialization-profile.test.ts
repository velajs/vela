import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModel } from '../define-model';
import { applyProfile, applyProfileToArray } from '../serialization-profile';
import type { SerializationProfile } from '../model.types';

const Schema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number().optional(),
  secret: z.string().optional(),
});

const modelWith = (profile?: SerializationProfile) =>
  defineModel({
    name: 'u',
    tableName: 'u',
    schema: Schema,
    ...(profile !== undefined ? { serializationProfile: profile } : {}),
  });

describe('applyProfile', () => {
  it('removes excluded fields on a NEW object without mutating the input', () => {
    const model = modelWith({ exclude: ['age', 'secret'] });
    const input = { id: '1', name: 'a', age: 30, secret: 's' };
    const out = applyProfile(model, input);
    expect(out).toEqual({ id: '1', name: 'a' });
    expect('age' in out).toBe(false);
    expect('secret' in out).toBe(false);
    expect(input.age).toBe(30);
  });

  it('passes through (same reference) when there is nothing to strip', () => {
    const record = { id: '1', name: 'a' };
    expect(applyProfile(modelWith(), record)).toBe(record);
    expect(applyProfile(modelWith({ exclude: [] }), record)).toBe(record);
    // Configured exclusion absent on the record → same reference too.
    expect(applyProfile(modelWith({ exclude: ['age'] }), record)).toBe(record);
  });

  it('normalizes through defineModel and applies to arrays independently', () => {
    const model = modelWith({ exclude: ['age'] });
    expect(model.serializationProfile).toEqual({ exclude: ['age'] });

    const rows = [
      { id: '1', name: 'a', age: 1 },
      { id: '2', name: 'b' },
    ];
    const out = applyProfileToArray(model, rows);
    expect(out.every((row) => !('age' in row))).toBe(true);
    expect(rows[0]!.age).toBe(1);
    // No-profile arrays pass through by reference.
    expect(applyProfileToArray(modelWith(), rows)).toBe(rows);
  });
});
