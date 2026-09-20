/**
 * The filter-clause builder: pick a column, an operator scoped to the column's
 * type, and a value, then add it as a `StudioGridFilter`. Active clauses render
 * as removable chips. Values are coerced to the column type so numeric/boolean
 * comparisons hit the wire as the right primitive.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { StudioColumn, StudioFilterOperator, StudioGridFilter } from '@velajs/studio-protocol';
import { formatCell } from '../format';

const OPERATORS_BY_TYPE: Record<StudioColumn['type'], StudioFilterOperator[]> = {
  string: ['eq', 'ne', 'like', 'ilike', 'null'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'null'],
  boolean: ['eq', 'ne'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  json: ['eq', 'ne', 'null'],
  unknown: ['eq', 'ne', 'null'],
};

function operatorsFor(column: StudioColumn | undefined): StudioFilterOperator[] {
  return column === undefined ? ['eq'] : OPERATORS_BY_TYPE[column.type];
}

/** Coerce a raw text value to the column's primitive type. */
function coerceValue(column: StudioColumn | undefined, raw: string): unknown {
  if (column === undefined) return raw;
  switch (column.type) {
    case 'number':
      return raw.trim() === '' ? raw : Number(raw);
    case 'boolean':
      return raw === 'true';
    default:
      return raw;
  }
}

export interface FilterBuilderProps {
  columns: StudioColumn[];
  filters: StudioGridFilter[];
  onAdd: (filter: StudioGridFilter) => void;
  onRemove: (index: number) => void;
}

export function FilterBuilder({
  columns,
  filters,
  onAdd,
  onRemove,
}: FilterBuilderProps): ReactNode {
  const [field, setField] = useState<string>(columns[0]?.name ?? '');
  const [operator, setOperator] = useState<StudioFilterOperator>('eq');
  const [value, setValue] = useState<string>('');

  const column = columns.find((c) => c.name === field);
  const operators = operatorsFor(column);
  const activeOperator = operators.includes(operator) ? operator : operators[0];
  const needsValue = activeOperator !== 'null';

  const submit = (): void => {
    if (field === '') return;
    onAdd({ field, operator: activeOperator, value: coerceValue(column, value) });
    setValue('');
  };

  return (
    <div className="vela-filters">
      <div className="vela-filters__builder">
        <select
          className="vela-select"
          aria-label="Filter column"
          value={field}
          onChange={(event) => setField(event.target.value)}
        >
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="vela-select"
          aria-label="Filter operator"
          value={activeOperator}
          onChange={(event) => setOperator(event.target.value as StudioFilterOperator)}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        {needsValue ? (
          <input
            className="vela-input"
            aria-label="Filter value"
            value={value}
            placeholder="value"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        ) : null}
        <button type="button" className="vela-btn" onClick={submit}>
          Add filter
        </button>
      </div>
      {filters.length > 0 ? (
        <div className="vela-filters__active">
          {filters.map((filter, index) => (
            <span
              key={`${filter.field}-${filter.operator}-${index}`}
              className="vela-chip vela-chip--filter"
            >
              <span className="vela-chip__val">
                {filter.field} {filter.operator}{' '}
                {filter.operator === 'null' ? '' : formatCell(filter.value)}
              </span>
              <button
                type="button"
                className="vela-chip__x"
                aria-label={`Remove filter ${filter.field}`}
                onClick={() => onRemove(index)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
