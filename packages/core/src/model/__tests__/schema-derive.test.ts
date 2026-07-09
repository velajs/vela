import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModel } from '../define-model';
import { deriveCreateSchema, deriveUpdateSchema } from '../schema-derive';

const Schema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  tenantId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

function keys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

describe('deriveCreateSchema', () => {
  it('strips generated PKs, timestamp columns, and the tenant field', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, multiTenant: true });
    expect(keys(deriveCreateSchema(model))).toEqual(['email', 'name', 'role']);
  });

  it('keeps timestamp/tenant columns as writable when those features are off', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, timestamps: false });
    // tenant off (default) and timestamps off → only the PK is stripped.
    expect(keys(deriveCreateSchema(model))).toEqual(['createdAt', 'email', 'name', 'role', 'tenantId', 'updatedAt']);
  });

  it('produces a schema whose parse rejects the stripped id field via strict? (fields simply absent)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const create = deriveCreateSchema(model);
    expect('id' in create.shape).toBe(false);
    expect('createdAt' in create.shape).toBe(false);
  });
});

describe('deriveUpdateSchema', () => {
  it('is the create base made fully partial (every field optional)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, multiTenant: true });
    const update = deriveUpdateSchema(model);
    expect(keys(update)).toEqual(['email', 'name', 'role']);
    // Partial: an empty object is valid.
    expect(update.safeParse({}).success).toBe(true);
    expect(update.safeParse({ name: 'x' }).success).toBe(true);
  });

  it('removes blocked fields in addition to the managed set', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const update = deriveUpdateSchema(model, { blocked: ['email'] });
    expect(keys(update)).toEqual(['name', 'role', 'tenantId']);
  });

  it('keeps only allowed fields when an allow-list is given', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const update = deriveUpdateSchema(model, { allowed: ['name', 'email'] });
    expect(keys(update)).toEqual(['email', 'name']);
  });

  it('applies blocked before allowed (a blocked field cannot be re-allowed)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const update = deriveUpdateSchema(model, { allowed: ['name', 'email'], blocked: ['email'] });
    expect(keys(update)).toEqual(['name']);
  });

  it('ignores allowed names that reference managed / absent fields (no throw)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    // 'id' is managed (already stripped) and 'ghost' is absent — both are no-ops.
    const update = deriveUpdateSchema(model, { allowed: ['name', 'id', 'ghost'] });
    expect(keys(update)).toEqual(['name']);
  });
});
