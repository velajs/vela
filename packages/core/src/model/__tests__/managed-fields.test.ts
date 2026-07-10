import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigurationException, InputValidationException } from '../../envelope/errors';
import { defineModel } from '../define-model';
import {
  applyManagedInsertFields,
  applyManagedUpdateFields,
  getManagedInputExclusions,
} from '../managed-fields';

const Schema = z.object({
  id: z.string(),
  name: z.string(),
  tenantId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('applyManagedInsertFields — PK strategy', () => {
  it("uuid (default) generates a crypto.randomUUID primary key", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const out = applyManagedInsertFields(model, { name: 'a' }, { databaseGeneratedId: false });
    expect(String(out.id)).toMatch(UUID_RE);
  });

  it('a caller-supplied non-empty PK wins untouched', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const out = applyManagedInsertFields(model, { id: 'given', name: 'a' }, { databaseGeneratedId: false });
    expect(out.id).toBe('given');
  });

  it('treats empty-string / null PK as unsupplied and generates one', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    expect(String(applyManagedInsertFields(model, { id: '' }, { databaseGeneratedId: false }).id)).toMatch(UUID_RE);
    expect(String(applyManagedInsertFields(model, { id: null }, { databaseGeneratedId: false }).id)).toMatch(UUID_RE);
  });

  it('a custom id function is invoked for the PK', () => {
    const id = vi.fn(() => 'custom-1');
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id });
    const out = applyManagedInsertFields(model, { name: 'a' }, { databaseGeneratedId: false });
    expect(out.id).toBe('custom-1');
    expect(id).toHaveBeenCalledOnce();
  });

  it("id:'database' omits the PK when the adapter supports databaseGeneratedId", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'database' });
    const out = applyManagedInsertFields(model, { id: undefined, name: 'a' }, { databaseGeneratedId: true });
    expect('id' in out).toBe(false);
  });

  it("id:'database' throws ConfigurationException when the adapter cannot generate keys", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'database' });
    expect(() => applyManagedInsertFields(model, { name: 'a' }, { databaseGeneratedId: false })).toThrow(
      ConfigurationException,
    );
  });

  it("id:'client' keeps a caller-supplied PK untouched", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'client' });
    const out = applyManagedInsertFields(model, { id: 'client-1', name: 'a' }, { databaseGeneratedId: false });
    expect(out.id).toBe('client-1');
  });

  it("id:'client' throws InputValidationException (400) when no PK is supplied", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'client' });
    expect(() => applyManagedInsertFields(model, { name: 'a' }, { databaseGeneratedId: false })).toThrow(
      InputValidationException,
    );
  });
});

describe('applyManagedInsertFields — timestamps', () => {
  it('stamps createdAt and updatedAt when timestamps are enabled (the default)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const before = Date.now();
    const out = applyManagedInsertFields(model, { name: 'a' }, { databaseGeneratedId: false });
    expect(typeof out.createdAt).toBe('number');
    expect(typeof out.updatedAt).toBe('number');
    expect(out.createdAt as number).toBeGreaterThanOrEqual(before);
  });

  it('does not overwrite a caller-supplied timestamp field', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const out = applyManagedInsertFields(model, { name: 'a', createdAt: 123 }, { databaseGeneratedId: false });
    expect(out.createdAt).toBe(123);
    expect(typeof out.updatedAt).toBe('number');
  });

  it('honors renamed / disabled timestamp columns', () => {
    const renamed = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      timestamps: { createdAt: 'created_ms', updatedAt: false },
    });
    const out = applyManagedInsertFields(renamed, { name: 'a' }, { databaseGeneratedId: false });
    expect(typeof out.created_ms).toBe('number');
    expect('updatedAt' in out).toBe(false);

    const off = defineModel({ name: 'u', tableName: 'u', schema: Schema, timestamps: false });
    const out2 = applyManagedInsertFields(off, { name: 'a' }, { databaseGeneratedId: false });
    expect('createdAt' in out2).toBe(false);
    expect('updatedAt' in out2).toBe(false);
  });

  it('never mutates the input record', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const input = { name: 'a' };
    applyManagedInsertFields(model, input, { databaseGeneratedId: false });
    expect(input).toEqual({ name: 'a' });
  });
});

describe('applyManagedUpdateFields', () => {
  it('always stamps updatedAt when configured, ignoring any client value', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const before = Date.now();
    const out = applyManagedUpdateFields(model, { name: 'b', updatedAt: 1 });
    expect(out.updatedAt as number).toBeGreaterThanOrEqual(before);
    expect(out.name).toBe('b');
  });

  it('never touches createdAt on update', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const out = applyManagedUpdateFields(model, { name: 'b' });
    expect('createdAt' in out).toBe(false);
  });

  it('returns a fresh object unchanged when timestamps are disabled', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, timestamps: false });
    const input = { name: 'b' };
    const out = applyManagedUpdateFields(model, input);
    expect(out).toEqual({ name: 'b' });
    expect(out).not.toBe(input);
  });

  it('honors a renamed updatedAt column', () => {
    const model = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      timestamps: { updatedAt: 'updated_ms' },
    });
    const out = applyManagedUpdateFields(model, { name: 'b' });
    expect(typeof out.updated_ms).toBe('number');
  });
});

describe('getManagedInputExclusions', () => {
  it('excludes primary keys + timestamp columns + tenant field', () => {
    const model = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      multiTenant: true,
    });
    const exclusions = new Set(getManagedInputExclusions(model));
    expect(exclusions).toEqual(new Set(['id', 'createdAt', 'updatedAt', 'tenantId']));
  });

  it("id:'client' does not exclude the primary key", () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, id: 'client', multiTenant: true });
    const exclusions = new Set(getManagedInputExclusions(model));
    expect(exclusions.has('id')).toBe(false);
    expect(exclusions).toEqual(new Set(['createdAt', 'updatedAt', 'tenantId']));
  });

  it('omits the tenant field when multi-tenancy is off, and timestamps when disabled', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema, timestamps: false });
    expect(getManagedInputExclusions(model)).toEqual(['id']);
  });

  it('can keep primary keys via includePrimaryKeys: false (upsert-style)', () => {
    const model = defineModel({ name: 'u', tableName: 'u', schema: Schema });
    const exclusions = new Set(getManagedInputExclusions(model, { includePrimaryKeys: false }));
    expect(exclusions.has('id')).toBe(false);
    expect(exclusions).toEqual(new Set(['createdAt', 'updatedAt']));
  });

  it('resolves renamed timestamp column names', () => {
    const model = defineModel({
      name: 'u',
      tableName: 'u',
      schema: Schema,
      timestamps: { createdAt: 'created_ms', updatedAt: 'updated_ms' },
    });
    const exclusions = new Set(getManagedInputExclusions(model));
    expect(exclusions).toEqual(new Set(['id', 'created_ms', 'updated_ms']));
  });
});
