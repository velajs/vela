import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModel } from '../define-model';
import {
  applyUpsertRestore,
  isRowVisible,
  isSoftDeleted,
  softDeleteFieldOf,
  softDeleteVisibilityFilter,
} from '../soft-delete';

const Schema = z.object({ id: z.string(), name: z.string(), deletedAt: z.number().nullable() });

const on = defineModel({ name: 'u', tableName: 'u', schema: Schema, softDelete: true });
const custom = defineModel({ name: 'u', tableName: 'u', schema: Schema, softDelete: { field: 'removedAt' } });
const off = defineModel({ name: 'u', tableName: 'u', schema: Schema });

describe('softDeleteFieldOf', () => {
  it('returns the resolved field when enabled, undefined when off', () => {
    expect(softDeleteFieldOf(on)).toBe('deletedAt');
    expect(softDeleteFieldOf(custom)).toBe('removedAt');
    expect(softDeleteFieldOf(off)).toBeUndefined();
  });
});

describe('isSoftDeleted', () => {
  it('is true only when the soft-delete column is non-null', () => {
    expect(isSoftDeleted(on, { deletedAt: 123 })).toBe(true);
    expect(isSoftDeleted(on, { deletedAt: null })).toBe(false);
    expect(isSoftDeleted(on, {})).toBe(false);
  });

  it('is always false when soft-delete is off', () => {
    expect(isSoftDeleted(off, { deletedAt: 123 })).toBe(false);
  });
});

describe('softDeleteVisibilityFilter', () => {
  it('defaults to "IS NULL" (live rows only)', () => {
    expect(softDeleteVisibilityFilter(on)).toEqual({ field: 'deletedAt', operator: 'null', value: true });
  });

  it('withDeleted yields no filter', () => {
    expect(softDeleteVisibilityFilter(on, { withDeleted: true })).toBeUndefined();
  });

  it('onlyDeleted yields "IS NOT NULL" and wins over withDeleted', () => {
    expect(softDeleteVisibilityFilter(on, { onlyDeleted: true })).toEqual({
      field: 'deletedAt',
      operator: 'null',
      value: false,
    });
    expect(softDeleteVisibilityFilter(on, { onlyDeleted: true, withDeleted: true })).toEqual({
      field: 'deletedAt',
      operator: 'null',
      value: false,
    });
  });

  it('returns no filter when soft-delete is off', () => {
    expect(softDeleteVisibilityFilter(off, { onlyDeleted: true })).toBeUndefined();
  });

  it('uses the custom field name', () => {
    expect(softDeleteVisibilityFilter(custom)).toEqual({ field: 'removedAt', operator: 'null', value: true });
  });
});

describe('isRowVisible', () => {
  const live = { deletedAt: null };
  const gone = { deletedAt: 123 };

  it('default: live visible, deleted hidden', () => {
    expect(isRowVisible(on, live)).toBe(true);
    expect(isRowVisible(on, gone)).toBe(false);
  });

  it('withDeleted: both visible', () => {
    expect(isRowVisible(on, gone, { withDeleted: true })).toBe(true);
    expect(isRowVisible(on, live, { withDeleted: true })).toBe(true);
  });

  it('onlyDeleted: only deleted visible', () => {
    expect(isRowVisible(on, gone, { onlyDeleted: true })).toBe(true);
    expect(isRowVisible(on, live, { onlyDeleted: true })).toBe(false);
  });

  it('always visible when soft-delete is off', () => {
    expect(isRowVisible(off, gone)).toBe(true);
  });
});

describe('applyUpsertRestore', () => {
  it('clears the soft-delete column when the existing row was deleted (match-and-restore)', () => {
    const out = applyUpsertRestore(on, { name: 'x' }, { deletedAt: 123 });
    expect(out).toEqual({ name: 'x', deletedAt: null });
  });

  it('returns data untouched when the existing row is live', () => {
    const data = { name: 'x' };
    expect(applyUpsertRestore(on, data, { deletedAt: null })).toBe(data);
  });

  it('returns data untouched when soft-delete is off', () => {
    const data = { name: 'x' };
    expect(applyUpsertRestore(off, data, { deletedAt: 123 })).toBe(data);
  });
});
