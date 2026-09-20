import { describe, expect, it } from 'vitest';
import { resolveSort } from '../sort';

describe('resolveSort', () => {
  it('uses the `sort` and `order` query param names', () => {
    // Locks the ported param names: `sort` selects the field, `order` the direction.
    expect(resolveSort({ sort: 'name', order: 'desc' }, { sortFields: ['name'] })).toEqual({
      field: 'name',
      order: 'desc',
    });
  });

  it('accepts any field when the allow-list is empty', () => {
    expect(resolveSort({ sort: 'whatever' })).toEqual({ field: 'whatever', order: 'asc' });
  });

  it('ignores a field outside the allow-list and falls back to defaultSort', () => {
    expect(
      resolveSort(
        { sort: 'evil' },
        { sortFields: ['name'], defaultSort: { field: 'id', order: 'desc' } },
      ),
    ).toEqual({ field: 'id', order: 'desc' });
  });

  it('validates direction and falls back on an invalid one', () => {
    expect(resolveSort({ sort: 'name', order: 'sideways' }, { sortFields: ['name'] })).toEqual({
      field: 'name',
      order: 'asc',
    });
    expect(
      resolveSort(
        { sort: 'name', order: 'sideways' },
        { sortFields: ['name'], defaultSort: { field: 'id', order: 'desc' } },
      ),
    ).toEqual({ field: 'name', order: 'desc' });
  });

  it('returns defaultSort when no sort param is supplied', () => {
    expect(resolveSort({}, { defaultSort: { field: 'createdAt', order: 'desc' } })).toEqual({
      field: 'createdAt',
      order: 'desc',
    });
  });

  it('returns undefined when nothing is resolvable', () => {
    expect(resolveSort({}, { sortFields: ['name'] })).toBeUndefined();
  });

  it('takes the first value of a repeated param', () => {
    expect(resolveSort({ sort: ['name', 'other'], order: ['asc', 'desc'] }, {})).toEqual({
      field: 'name',
      order: 'asc',
    });
  });
});
