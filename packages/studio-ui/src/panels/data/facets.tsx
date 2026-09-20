/**
 * Facet chips: per low-cardinality column, `data.facets` returns value/count
 * buckets rendered as toggle chips. Clicking a chip adds (or removes) an `eq`
 * filter on that column — the fastest path from "what values exist" to a filtered
 * grid. Only rendered when the model's `supports.facets` is true.
 */
import type { ReactNode } from 'react';
import type { StudioColumn, StudioGridFilter } from '@velajs/studio-protocol';
import { useAdminQuery } from '../../data/query';
import { formatCell } from '../format';

/** Columns worth faceting: booleans and small enum-like string columns. */
const ENUM_NAMES = new Set(['role', 'status', 'kind', 'type', 'level', 'mode', 'state']);

export function facetableColumns(columns: StudioColumn[]): StudioColumn[] {
  return columns.filter(
    (column) =>
      column.type === 'boolean' ||
      (column.type === 'string' && !column.pk && !column.unique && ENUM_NAMES.has(column.name)),
  );
}

function hasFilter(filters: StudioGridFilter[], field: string, value: unknown): boolean {
  return filters.some((f) => f.field === field && f.operator === 'eq' && f.value === value);
}

function FacetSection({
  model,
  column,
  filters,
  onToggle,
}: {
  model: string;
  column: StudioColumn;
  filters: StudioGridFilter[];
  onToggle: (field: string, value: unknown) => void;
}): ReactNode {
  const facets = useAdminQuery('data.facets', { model, field: column.name });
  if (facets.error !== null || facets.data === undefined) return null;
  if (facets.data.buckets.length === 0) return null;
  return (
    <div className="vela-facet">
      <span className="vela-facet__label">{column.name}</span>
      <div className="vela-facet__chips">
        {facets.data.buckets.map((bucket, index) => {
          const active = hasFilter(filters, column.name, bucket.value);
          return (
            <button
              key={`${formatCell(bucket.value)}-${index}`}
              type="button"
              className="vela-chip"
              data-active={active ? 'true' : undefined}
              aria-pressed={active}
              onClick={() => onToggle(column.name, bucket.value)}
            >
              <span className="vela-chip__val">{formatCell(bucket.value)}</span>
              <span className="vela-chip__count">{bucket.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface FacetBarProps {
  model: string;
  columns: StudioColumn[];
  filters: StudioGridFilter[];
  onToggle: (field: string, value: unknown) => void;
}

export function FacetBar({ model, columns, filters, onToggle }: FacetBarProps): ReactNode {
  const facetable = facetableColumns(columns);
  if (facetable.length === 0) return null;
  return (
    <div className="vela-facets" role="group" aria-label="Facets">
      {facetable.map((column) => (
        <FacetSection
          key={column.name}
          model={model}
          column={column}
          filters={filters}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
