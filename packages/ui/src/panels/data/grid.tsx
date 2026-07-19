/**
 * The virtualized data grid: `@tanstack/react-table` owns the column model +
 * header/cell rendering, `@tanstack/react-virtual` windows the row list so a
 * wide page never mounts every row. Sorting is driven off the URL view state
 * (clicking a header cycles asc → desc → none) — the grid is otherwise a pure
 * render of the current `data.listRows` page.
 */
import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { StudioColumn } from '@velajs/studio-protocol';
import { formatCell } from '../format';
import type { DataView, SortOrder } from './view-state';

type Row = Record<string, unknown>;

const ROW_HEIGHT = 34;

function nextSort(
  current: DataView['sort'],
  field: string,
): { field: string; order: SortOrder } | null {
  if (current === null || current.field !== field) return { field, order: 'asc' };
  if (current.order === 'asc') return { field, order: 'desc' };
  return null;
}

function sortIndicator(sort: DataView['sort'], field: string): string {
  if (sort === null || sort.field !== field) return '';
  return sort.order === 'asc' ? ' ▲' : ' ▼';
}

/** Row-selection wiring for the checkbox column (write mode only). */
export interface GridSelection {
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], select: boolean) => void;
}

export interface DataGridProps {
  columns: StudioColumn[];
  rows: Row[];
  pkField: string;
  sort: DataView['sort'];
  onSortChange: (sort: DataView['sort']) => void;
  onSelectRow: (id: string) => void;
  /** When present, a leading checkbox column renders for bulk delete. */
  selection?: GridSelection;
}

export function DataGrid({
  columns,
  rows,
  pkField,
  sort,
  onSortChange,
  onSelectRow,
  selection,
}: DataGridProps): ReactNode {
  const columnDefs = useMemo(() => {
    const helper = createColumnHelper<Row>();
    return columns.map((column) =>
      helper.accessor((row) => row[column.name], {
        id: column.name,
        header: column.name,
        cell: (info) => formatCell(info.getValue()),
      }),
    );
  }, [columns]);

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableSortingRemoval: true,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // happy-dom reports zero-size rects, so seed a real viewport: without this
    // the virtualizer would window to an empty range under the test DOM.
    initialRect: { width: 960, height: 480 },
  });

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;
  const colCount = columns.length + (selection !== undefined ? 1 : 0);

  const pageIds = selection !== undefined ? rows.map((row) => formatCell(row[pkField])) : [];
  const allSelected =
    selection !== undefined &&
    pageIds.length > 0 &&
    pageIds.every((id) => selection.selectedIds.has(id));

  return (
    <div className="vela-grid" ref={scrollRef} data-testid="data-grid">
      <table className="vela-grid__table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {selection !== undefined ? (
                <th className="vela-grid__th vela-grid__th--check">
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={allSelected}
                    onChange={(event) => selection.onToggleAll(pageIds, event.target.checked)}
                  />
                </th>
              ) : null}
              {group.headers.map((header) => (
                <th key={header.id} className="vela-grid__th">
                  <button
                    type="button"
                    className="vela-grid__sort"
                    onClick={() => onSortChange(nextSort(sort, header.column.id))}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    <span className="vela-grid__sort-ind">
                      {sortIndicator(sort, header.column.id)}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={colCount} style={{ height: paddingTop }} />
            </tr>
          ) : null}
          {virtualRows.map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            const id = formatCell(row.original[pkField]);
            return (
              <tr
                key={row.id}
                className="vela-grid__row"
                data-testid="data-grid-row"
                onClick={() => onSelectRow(id)}
              >
                {selection !== undefined ? (
                  <td
                    className="vela-grid__td vela-grid__td--check"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select row ${id}`}
                      checked={selection.selectedIds.has(id)}
                      onChange={() => selection.onToggle(id)}
                    />
                  </td>
                ) : null}
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="vela-grid__td" title={formatCell(cell.getValue())}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
          {paddingBottom > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={colCount} style={{ height: paddingBottom }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
