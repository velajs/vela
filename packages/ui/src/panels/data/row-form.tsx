/**
 * The row editor shared by create ("New row") and edit (row-detail drawer) flows.
 * Fields derive from `describeModel` columns: managed columns and primary keys
 * are read-only (a db-generated pk is never user-set), every other column gets a
 * type-appropriate control. Create emits a patch of the fields the user filled;
 * edit emits ONLY the fields whose value changed — the minimal `data.writeRow`
 * patch either way. Value coercion mirrors the grid filter builder so the wire
 * carries the right primitive.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { StudioColumn } from '@velajs/studio-protocol';
import type { AdminError } from '../../client/admin-client';

/** A column the form must not let the user edit (shown disabled for context). */
function isReadOnly(column: StudioColumn): boolean {
  return column.managed || column.pk;
}

/** Render an existing row value as an input string. */
function toInputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/** Coerce a raw input string back to the column's primitive type. */
function coerceField(column: StudioColumn, raw: string): unknown {
  if (raw === '') return column.nullable ? null : column.type === 'string' ? '' : null;
  switch (column.type) {
    case 'number': {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case 'boolean':
      return raw === 'true';
    case 'json':
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

/** Structural equality good enough to detect a staged change (incl. JSON). */
function unchanged(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export interface RowFormProps {
  columns: StudioColumn[];
  mode: 'create' | 'edit';
  /** The current row values (edit mode). */
  initial?: Record<string, unknown>;
  onSubmit: (patch: Record<string, unknown>) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: AdminError | null;
}

export function RowForm({
  columns,
  mode,
  initial,
  onSubmit,
  onCancel,
  busy = false,
  error = null,
}: RowFormProps): ReactNode {
  const editable = useMemo(() => columns.filter((column) => !isReadOnly(column)), [columns]);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const column of editable) {
      seed[column.name] = toInputValue(initial?.[column.name]);
    }
    return seed;
  });

  const setField = (name: string, next: string): void => {
    setValues((prev) => ({ ...prev, [name]: next }));
  };

  const submit = (): void => {
    const patch: Record<string, unknown> = {};
    for (const column of editable) {
      const raw = values[column.name] ?? '';
      const coerced = coerceField(column, raw);
      if (mode === 'edit') {
        if (!unchanged(coerced, initial?.[column.name])) patch[column.name] = coerced;
      } else if (column.type === 'boolean' || raw !== '') {
        // Create: send booleans always, and any field the user actually filled.
        patch[column.name] = coerced;
      }
    }
    onSubmit(patch);
  };

  return (
    <form
      className="vela-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {columns.map((column) => {
        const readOnly = isReadOnly(column);
        const value = readOnly ? toInputValue(initial?.[column.name]) : (values[column.name] ?? '');
        const label = `${column.name}${column.nullable ? '' : ' *'}`;
        return (
          <label className="vela-form__field" key={column.name}>
            <span className="vela-form__label">
              {label}
              <span className="vela-form__type">{column.type}</span>
            </span>
            {readOnly ? (
              <input
                className="vela-input"
                aria-label={column.name}
                value={mode === 'create' ? '' : value}
                placeholder={mode === 'create' ? '(auto)' : undefined}
                disabled
                readOnly
              />
            ) : column.type === 'boolean' ? (
              <select
                className="vela-select"
                aria-label={column.name}
                value={value === 'true' ? 'true' : 'false'}
                onChange={(event) => setField(column.name, event.target.value)}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : column.type === 'json' ? (
              <textarea
                className="vela-textarea"
                aria-label={column.name}
                value={value}
                onChange={(event) => setField(column.name, event.target.value)}
              />
            ) : (
              <input
                className="vela-input"
                aria-label={column.name}
                type={column.type === 'number' ? 'number' : 'text'}
                value={value}
                placeholder={column.nullable ? '(null)' : ''}
                onChange={(event) => setField(column.name, event.target.value)}
              />
            )}
          </label>
        );
      })}

      {error !== null ? (
        <p className="vela-state__message" role="alert">
          {error.hint ?? error.body.message}
        </p>
      ) : null}

      <div className="vela-form__actions">
        <button type="button" className="vela-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="vela-btn vela-btn--primary" disabled={busy}>
          {mode === 'create' ? 'Create row' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
