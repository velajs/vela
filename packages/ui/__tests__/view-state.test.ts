import { describe, expect, it } from 'vitest';
import type { StudioGridFilter } from '@velajs/studio-protocol';
import {
  DEFAULT_DATA_VIEW,
  decodeDataViewSearch,
  toDataView,
  toListRowsRequest,
  toSearch,
} from '../src/panels/data/view-state';
import type { DataView } from '../src/panels/data/view-state';

describe('data view-state codec', () => {
  it('round-trips a rich view through the URL-facing search and back', () => {
    const filters: StudioGridFilter[] = [
      { field: 'role', operator: 'eq', value: 'admin' },
      { field: 'active', operator: 'eq', value: true },
    ];
    const view: DataView = {
      model: 'user',
      search: 'ada',
      page: 3,
      perPage: 50,
      sort: { field: 'email', order: 'desc' },
      filters,
      withDeleted: true,
    };
    expect(toDataView(toSearch(view))).toEqual(view);
  });

  it('drops defaults from the URL to keep shared links clean', () => {
    expect(toSearch(DEFAULT_DATA_VIEW)).toEqual({});
    expect(toSearch({ ...DEFAULT_DATA_VIEW, model: 'post' })).toEqual({ model: 'post' });
  });

  it('coerces raw string params (URL query) into typed primitives', () => {
    const search = decodeDataViewSearch({
      model: 'user',
      page: '4',
      perPage: '10',
      sort: 'email:asc',
      del: 'true',
      unknownKey: 'ignored',
    });
    expect(search).toEqual({ model: 'user', page: 4, perPage: 10, sort: 'email:asc', del: true });
    const view = toDataView(search);
    expect(view.page).toBe(4);
    expect(view.sort).toEqual({ field: 'email', order: 'asc' });
    expect(view.withDeleted).toBe(true);
  });

  it('rejects malformed sort/filters rather than throwing', () => {
    expect(toDataView({ sort: 'garbage' }).sort).toBeNull();
    expect(toDataView({ filters: 'not-json' }).filters).toEqual([]);
    expect(toDataView({ filters: JSON.stringify([{ bad: true }]) }).filters).toEqual([]);
  });

  it('projects a view onto a data.listRows request, omitting empty parts', () => {
    const minimal = toListRowsRequest(DEFAULT_DATA_VIEW, 'user');
    expect(minimal).toEqual({ model: 'user', page: 1, perPage: 25 });

    const full = toListRowsRequest(
      {
        model: 'user',
        search: 'x',
        page: 2,
        perPage: 10,
        sort: { field: 'name', order: 'asc' },
        filters: [{ field: 'role', operator: 'eq', value: 'admin' }],
        withDeleted: true,
      },
      'user',
    );
    expect(full).toEqual({
      model: 'user',
      page: 2,
      perPage: 10,
      search: 'x',
      sort: { field: 'name', order: 'asc' },
      filters: [{ field: 'role', operator: 'eq', value: 'admin' }],
      withDeleted: true,
    });
  });
});
