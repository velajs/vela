/**
 * Small, dependency-free formatting helpers shared across the read panels.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** Format an epoch-ms timestamp as an ISO-ish `YYYY-MM-DD HH:MM:SS` string. */
export function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** A compact `time-of-day` clock (`HH:MM:SS`) for dense log/audit rows. */
export function formatClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** Render an unknown cell value as a stable, dense string. */
export function formatCell(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Pretty-print a JSON-able value; falls back to `String` for cyclic values. */
export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
