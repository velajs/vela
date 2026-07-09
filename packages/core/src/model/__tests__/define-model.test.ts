import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModel } from '../define-model';

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  tenantId: z.string(),
  deletedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

describe('defineModel normalization', () => {
  it('resolves every default (primaryKeys, id, namePlural, timestamps ON, flags OFF)', () => {
    const model = defineModel({ name: 'user', tableName: 'users', schema: UserSchema });

    expect(model.name).toBe('user');
    expect(model.namePlural).toBe('users');
    expect(model.tableName).toBe('users');
    expect(model.primaryKeys).toEqual(['id']);
    expect(model.id).toBe('uuid');
    // Native-engine default: timestamps ON with conventional field names.
    expect(model.timestamps).toEqual({ createdAt: 'createdAt', updatedAt: 'updatedAt' });
    expect(model.softDeleteField).toBeUndefined();
    expect(model.tenantField).toBeUndefined();
    expect(model.versioning).toBe(false);
    expect(model.audit).toBe(false);
  });

  it('honors an explicit namePlural and custom primaryKeys', () => {
    const model = defineModel({
      name: 'person',
      namePlural: 'people',
      tableName: 'people',
      schema: UserSchema,
      primaryKeys: ['id'],
    });
    expect(model.namePlural).toBe('people');
    expect(model.primaryKeys).toEqual(['id']);
  });

  it('resolves softDelete: true → default field, and object → custom field', () => {
    expect(defineModel({ name: 'u', tableName: 'u', schema: UserSchema, softDelete: true }).softDeleteField).toBe('deletedAt');
    expect(
      defineModel({ name: 'u', tableName: 'u', schema: UserSchema, softDelete: { field: 'removedAt' } }).softDeleteField,
    ).toBe('removedAt');
    expect(defineModel({ name: 'u', tableName: 'u', schema: UserSchema, softDelete: false }).softDeleteField).toBeUndefined();
  });

  it('resolves multiTenant: true → default field, and object → custom field', () => {
    expect(defineModel({ name: 'u', tableName: 'u', schema: UserSchema, multiTenant: true }).tenantField).toBe('tenantId');
    expect(
      defineModel({ name: 'u', tableName: 'u', schema: UserSchema, multiTenant: { field: 'orgId' } }).tenantField,
    ).toBe('orgId');
    expect(defineModel({ name: 'u', tableName: 'u', schema: UserSchema, multiTenant: false }).tenantField).toBeUndefined();
  });

  it('normalizes timestamps: false disables both columns', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: UserSchema, timestamps: false });
    expect(model.timestamps).toEqual({ createdAt: false, updatedAt: false });
  });

  it('normalizes timestamps object: renames one field and per-field disable', () => {
    const renamed = defineModel({
      name: 'e',
      tableName: 'events',
      schema: UserSchema,
      timestamps: { createdAt: 'created_ms' },
    });
    // updatedAt defaults to its conventional name when only createdAt is given.
    expect(renamed.timestamps).toEqual({ createdAt: 'created_ms', updatedAt: 'updatedAt' });

    const partialOff = defineModel({
      name: 'e',
      tableName: 'events',
      schema: UserSchema,
      timestamps: { updatedAt: false },
    });
    expect(partialOff.timestamps).toEqual({ createdAt: 'createdAt', updatedAt: false });
  });

  it('accepts a custom id strategy function and passes it through', () => {
    const gen = () => 'custom-id';
    const model = defineModel({ name: 'u', tableName: 'u', schema: UserSchema, id: gen });
    expect(model.id).toBe(gen);
  });

  it('returns a fresh object without mutating the input config', () => {
    const config = { name: 'user', tableName: 'users', schema: UserSchema, primaryKeys: ['id'] as ['id'] };
    const model = defineModel(config);
    expect(model).not.toBe(config);
    // Normalizing did not add resolved fields onto the author's config.
    expect('timestamps' in config).toBe(false);
    expect('softDeleteField' in config).toBe(false);
  });

  it('passes relations/computedFields/policies/resolveSchema/table through', () => {
    const resolveSchema = () => UserSchema;
    const table = { marker: true };
    const model = defineModel({
      name: 'user',
      tableName: 'users',
      schema: UserSchema,
      relations: { self: { type: 'belongsTo', target: 'users', foreignKey: 'id' } },
      computedFields: { greeting: { compute: (r) => `hi ${String(r.name)}` } },
      resolveSchema,
      table,
    });
    expect(model.relations?.self.target).toBe('users');
    expect(model.computedFields?.greeting).toBeDefined();
    expect(model.resolveSchema).toBe(resolveSchema);
    expect(model.table).toBe(table);
  });

  it('leaves relations undefined when none are authored', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: UserSchema });
    expect(model.relations).toBeUndefined();
  });
});
