/**
 * The data browser — the flagship read panel. A model sidebar (`data.listModels`)
 * drives a header (`data.describeModel`) + a virtualized grid (`data.listRows`)
 * with sort, filter clauses, faceting (`data.facets`), substring search,
 * pagination, a soft-delete toggle, and a row-detail drawer (`data.readRow`).
 *
 * The ENTIRE view state lives in the URL search params: every control writes
 * through `navigate`, and the panel renders purely off what it reads back — so
 * the link is the query and a fresh mount hydrates identically.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { StudioGridFilter, StudioModelInfo } from '@velajs/studio-protocol';
import { useAdminMutation, useAdminQuery } from '../../data/query';
import { useStudioCapabilities } from '../../data/capabilities';
import { Panel, QueryView, Badge, Drawer, JsonBlock, KeyValueList } from '../shared';
import { EmptyState, AdminErrorView } from '../shared';
import { DataGrid } from './grid';
import { DataWrites } from './writes';
import { RowForm } from './row-form';
import { FacetBar } from './facets';
import { FilterBuilder } from './filters';
import {
  DEFAULT_DATA_VIEW,
  DEFAULT_PER_PAGE,
  decodeDataViewSearch,
  toDataView,
  toListRowsRequest,
  toSearch,
} from './view-state';
import type { DataView } from './view-state';

const PER_PAGE_OPTIONS = [10, 25, 50, 100];

function ModelSidebar({
  models,
  active,
  onSelect,
}: {
  models: StudioModelInfo[];
  active: string | null;
  onSelect: (model: string) => void;
}): ReactNode {
  return (
    <aside className="vela-models" aria-label="Models">
      <ul className="vela-models__list">
        {models.map((model) => (
          <li key={model.name}>
            <button
              type="button"
              className="vela-models__item"
              data-active={active === model.name ? 'true' : undefined}
              onClick={() => onSelect(model.name)}
            >
              <span className="vela-models__name">{model.label}</span>
              <span className="vela-models__table">{model.table}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default function DataPanel(): ReactNode {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false });
  const view = useMemo(() => toDataView(decodeDataViewSearch(rawSearch)), [rawSearch]);
  const { capabilities } = useStudioCapabilities();
  const canEdit = capabilities.writes.dataEditable;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState(false);
  const editMutation = useAdminMutation('data.writeRow', {
    invalidates: ['data.listRows', 'data.readRow'],
  });

  const update = (next: DataView): void => {
    void navigate({ to: '/data', search: () => toSearch(next) });
  };

  const models = useAdminQuery('data.listModels', {});
  const model = view.model;
  const describe = useAdminQuery(
    'data.describeModel',
    { model: model ?? '' },
    { enabled: model !== null },
  );
  const descriptor = describe.data;
  const rowsRequest = model !== null ? toListRowsRequest(view, model) : { model: '' };
  const rows = useAdminQuery('data.listRows', rowsRequest, {
    enabled: model !== null,
    keepPreviousData: true,
  });
  const detail = useAdminQuery(
    'data.readRow',
    { model: model ?? '', id: selectedId ?? '' },
    { enabled: model !== null && selectedId !== null },
  );

  const selectModel = (name: string): void => {
    setSelectedId(null);
    setSelectedIds(new Set());
    setEditing(false);
    update({ ...DEFAULT_DATA_VIEW, model: name });
  };

  const openRow = (id: string): void => {
    setSelectedId(id);
    setEditing(false);
  };

  const closeRow = (): void => {
    setSelectedId(null);
    setEditing(false);
    editMutation.reset();
  };

  const toggleSelect = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (ids: string[], select: boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const toggleFacet = (field: string, value: unknown): void => {
    const exists = view.filters.some(
      (f) => f.field === field && f.operator === 'eq' && f.value === value,
    );
    const filters: StudioGridFilter[] = exists
      ? view.filters.filter((f) => !(f.field === field && f.operator === 'eq' && f.value === value))
      : [...view.filters, { field, operator: 'eq', value }];
    update({ ...view, filters, page: 1 });
  };

  return (
    <Panel title="Data" description="Browse managed models. The URL captures the full query.">
      <QueryView
        result={models}
        isEmpty={(list) => list.length === 0}
        emptyLabel="No models are managed by this deployment."
      >
        {(modelList) => (
          <div className="vela-data">
            <ModelSidebar models={modelList} active={model} onSelect={selectModel} />
            <div className="vela-data__main">
              {model === null ? (
                <EmptyState
                  label="Select a model"
                  hint="Pick a model from the list to browse its rows."
                />
              ) : describe.error !== null ? (
                <AdminErrorView error={describe.error} />
              ) : descriptor === undefined ? (
                <EmptyState label="Loading model…" />
              ) : (
                <div className="vela-data__model">
                  <div className="vela-data__header">
                    <div className="vela-data__flags">
                      <Badge tone="accent">{descriptor.columns.length} columns</Badge>
                      {descriptor.flags.softDelete ? <Badge tone="muted">soft-delete</Badge> : null}
                      {descriptor.flags.multiTenant ? (
                        <Badge tone="muted">multi-tenant</Badge>
                      ) : null}
                      {descriptor.supports.search ? <Badge tone="neutral">search</Badge> : null}
                      {descriptor.supports.facets ? <Badge tone="neutral">facets</Badge> : null}
                    </div>
                    <div className="vela-data__toolbar">
                      {descriptor.supports.search ? (
                        <input
                          className="vela-input"
                          type="search"
                          aria-label="Search rows"
                          placeholder="Search…"
                          value={view.search}
                          onChange={(event) =>
                            update({ ...view, search: event.target.value, page: 1 })
                          }
                        />
                      ) : null}
                      {descriptor.flags.softDelete ? (
                        <label className="vela-check">
                          <input
                            type="checkbox"
                            checked={view.withDeleted}
                            onChange={(event) =>
                              update({ ...view, withDeleted: event.target.checked, page: 1 })
                            }
                          />
                          <span>Show deleted</span>
                        </label>
                      ) : null}
                    </div>
                  </div>

                  {canEdit ? (
                    <DataWrites
                      descriptor={descriptor}
                      selectedIds={selectedIds}
                      onClearSelection={() => setSelectedIds(new Set())}
                    />
                  ) : null}

                  <FilterBuilder
                    columns={descriptor.columns}
                    filters={view.filters}
                    onAdd={(filter) =>
                      update({ ...view, filters: [...view.filters, filter], page: 1 })
                    }
                    onRemove={(index) =>
                      update({
                        ...view,
                        filters: view.filters.filter((_, i) => i !== index),
                        page: 1,
                      })
                    }
                  />

                  {descriptor.supports.facets ? (
                    <FacetBar
                      model={descriptor.name}
                      columns={descriptor.columns}
                      filters={view.filters}
                      onToggle={toggleFacet}
                    />
                  ) : null}

                  <QueryView
                    result={rows}
                    isEmpty={(page) => page.rows.length === 0}
                    emptyLabel="No rows match this query."
                  >
                    {(page) => (
                      <>
                        <DataGrid
                          columns={descriptor.columns}
                          rows={page.rows}
                          pkField={descriptor.primaryKeys[0] ?? 'id'}
                          sort={view.sort}
                          onSortChange={(sort) => update({ ...view, sort })}
                          onSelectRow={openRow}
                          selection={
                            canEdit
                              ? {
                                  selectedIds,
                                  onToggle: toggleSelect,
                                  onToggleAll: toggleSelectAll,
                                }
                              : undefined
                          }
                        />
                        <div className="vela-pager">
                          <span className="vela-pager__info">
                            {page.info.total_count ?? page.rows.length} rows · page {page.info.page}
                            {page.info.total_pages !== undefined
                              ? ` of ${page.info.total_pages}`
                              : ''}
                          </span>
                          <div className="vela-pager__controls">
                            <select
                              className="vela-select"
                              aria-label="Rows per page"
                              value={view.perPage}
                              onChange={(event) =>
                                update({
                                  ...view,
                                  perPage: Number(event.target.value) || DEFAULT_PER_PAGE,
                                  page: 1,
                                })
                              }
                            >
                              {PER_PAGE_OPTIONS.map((n) => (
                                <option key={n} value={n}>
                                  {n} / page
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="vela-btn"
                              disabled={!page.info.has_prev_page}
                              onClick={() => update({ ...view, page: Math.max(1, view.page - 1) })}
                            >
                              Prev
                            </button>
                            <button
                              type="button"
                              className="vela-btn"
                              disabled={!page.info.has_next_page}
                              onClick={() => update({ ...view, page: view.page + 1 })}
                            >
                              Next
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </QueryView>
                </div>
              )}
            </div>
          </div>
        )}
      </QueryView>

      <Drawer
        open={selectedId !== null}
        title={selectedId !== null ? `Row ${selectedId}` : 'Row'}
        onClose={closeRow}
      >
        {detail.error !== null ? (
          <AdminErrorView error={detail.error} />
        ) : detail.data === undefined ? (
          <p className="vela-state__hint">Loading…</p>
        ) : detail.data === null ? (
          <EmptyState label="Row not found" />
        ) : editing && descriptor !== undefined ? (
          <RowForm
            columns={descriptor.columns}
            mode="edit"
            initial={detail.data}
            busy={editMutation.isPending}
            error={editMutation.error}
            onCancel={() => {
              setEditing(false);
              editMutation.reset();
            }}
            onSubmit={(patch) =>
              editMutation.mutate(
                { model: model ?? '', id: selectedId ?? '', patch },
                {
                  onSuccess: () => {
                    setEditing(false);
                    editMutation.reset();
                  },
                },
              )
            }
          />
        ) : (
          <>
            {canEdit ? (
              <div className="vela-drawer__toolbar">
                <button type="button" className="vela-btn" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </div>
            ) : null}
            <KeyValueList
              rows={Object.entries(detail.data).map(([key, value]) => [
                key,
                <JsonBlock key={key} value={value} />,
              ])}
            />
          </>
        )}
      </Drawer>
    </Panel>
  );
}
