/**
 * `@velajs/crud/csv` — RFC 4180-style CSV generation + parsing.
 *
 * A faithful, edge-safe port of hono-crud 0.13's `utils/csv.ts` escaping and
 * parsing semantics (string building + Web APIs only — no `node:*`, no
 * `Buffer`). Backs the `/export` (generate) and `/import` (parse) verbs.
 *
 * Escaping contract preserved byte-for-byte:
 *  - `null`/`undefined` → `nullValue` (default empty cell).
 *  - `Date` → ISO / locale / epoch per `dateFormat` (checked before objects).
 *  - arrays/objects → `JSON.stringify` then re-escaped (so they get quoted).
 *  - booleans → `'true'` / `'false'`.
 *  - CSV-formula-injection guard: a value starting with `= + - @ \t \r` is
 *    wrapped as `"\t<doubled-quotes>"` (leading TAB inside quotes, OWASP).
 *  - otherwise quote iff the value contains the delimiter, a `"`, or a newline;
 *    inner `"` is doubled.
 *  - rows joined by `\r\n` (CRLF) by default; no trailing row delimiter.
 *
 * Parsing contract preserved: quoted fields, doubled-quote (`""`→`"`), embedded
 * commas + newlines, and CRLF/CR/LF line breaks are all honored; cells stay
 * STRINGS (no numeric/boolean coercion) unless a per-field `parsers` entry is
 * supplied; the header row becomes the record keys.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CsvGenerateOptions {
  /** Column headers. Defaults to the first record's keys. */
  headers?: string[];
  /** Field delimiter. @default ',' */
  delimiter?: string;
  /** Row delimiter. @default '\r\n' (RFC 4180). */
  rowDelimiter?: string;
  /** Emit a header row. @default true */
  includeHeader?: boolean;
  /** Fields to exclude from output. */
  excludeFields?: string[];
  /** How to render null/undefined. @default '' */
  nullValue?: string;
  /** Date rendering. @default 'iso' */
  dateFormat?: 'iso' | 'locale' | 'timestamp';
}

export interface CsvParseOptions {
  /** Field delimiter. @default ',' */
  delimiter?: string;
  /** First row is a header row. @default true */
  hasHeader?: boolean;
  /** Explicit headers (override the file's header row). */
  headers?: string[];
  /** Trim whitespace from cells + headers. @default true */
  trimValues?: boolean;
  /** Skip blank rows. @default true */
  skipEmptyRows?: boolean;
  /** How to represent an empty cell. @default 'empty' (keep `''`). */
  emptyValue?: 'null' | 'undefined' | 'empty';
}

export interface CsvParseError {
  /** 1-indexed row number. */
  row: number;
  message: string;
  content?: string;
}

export interface CsvParseResult<T = Record<string, unknown>> {
  data: T[];
  headers: string[];
  errors: CsvParseError[];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Escape one value for CSV output (RFC 4180 + formula-injection guard). */
export function escapeCsvValue(
  value: unknown,
  options: Pick<CsvGenerateOptions, 'delimiter' | 'nullValue' | 'dateFormat'> = {},
): string {
  const { delimiter = ',', nullValue = '', dateFormat = 'iso' } = options;

  if (value === null || value === undefined) {
    return nullValue;
  }

  if (value instanceof Date) {
    switch (dateFormat) {
      case 'timestamp':
        return String(value.getTime());
      case 'locale':
        return value.toLocaleString();
      default:
        return value.toISOString();
    }
  }

  if (typeof value === 'object') {
    return escapeCsvValue(JSON.stringify(value), options);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  const str = String(value);

  // Formula-injection guard (OWASP): prefix a literal TAB inside quotes.
  const firstChar = str.charAt(0);
  if (
    firstChar === '=' ||
    firstChar === '+' ||
    firstChar === '-' ||
    firstChar === '@' ||
    firstChar === '\t' ||
    firstChar === '\r'
  ) {
    const escaped = str.replace(/"/g, '""');
    return `"\t${escaped}"`;
  }

  const needsQuoting =
    str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r');
  if (needsQuoting) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Generate a CSV string from records. Columns come from `options.headers` or
 * the first record's key order (minus `excludeFields`). An empty record set
 * yields the empty string (no header row) — hono-crud parity.
 */
export function generateCsv<T extends Record<string, unknown>>(
  records: T[],
  options: CsvGenerateOptions = {},
): string {
  const {
    delimiter = ',',
    rowDelimiter = '\r\n',
    includeHeader = true,
    excludeFields = [],
    nullValue = '',
    dateFormat = 'iso',
  } = options;

  if (records.length === 0) {
    return '';
  }

  let headers = options.headers ?? Object.keys(records[0]);
  headers = headers.filter((h) => !excludeFields.includes(h));

  const cellOptions = { delimiter, nullValue, dateFormat };
  const lines: string[] = [];

  if (includeHeader) {
    lines.push(headers.map((h) => escapeCsvValue(h, cellOptions)).join(delimiter));
  }
  for (const record of records) {
    lines.push(headers.map((h) => escapeCsvValue(record[h], cellOptions)).join(delimiter));
  }

  return lines.join(rowDelimiter);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split one line into fields, honoring quotes + doubled-quote escapes. */
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (char === delimiter) {
        fields.push(current);
        current = '';
        i++;
        continue;
      }
      current += char;
      i++;
    }
  }
  fields.push(current);
  return fields;
}

/** Split content into lines, honoring quoted newlines and CRLF/CR/LF. */
function splitCsvLines(content: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      if (inQuotes && i + 1 < content.length && content[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && i + 1 < content.length && content[i + 1] === '\n') {
        i++;
      }
      if (current.length > 0) {
        lines.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

/**
 * Parse a CSV string into records. The header row (default) becomes the record
 * keys; cells stay strings (no coercion). Rows with fewer fields than headers
 * back-fill trailing keys with the empty-cell value; extra fields are dropped.
 */
export function parseCsv<T = Record<string, unknown>>(
  content: string,
  options: CsvParseOptions = {},
): CsvParseResult<T> {
  const {
    delimiter = ',',
    hasHeader = true,
    trimValues = true,
    skipEmptyRows = true,
    emptyValue = 'empty',
  } = options;

  const result: CsvParseResult<T> = { data: [], headers: [], errors: [] };

  const lines = splitCsvLines(content);
  if (lines.length === 0) return result;

  let startIndex = 0;
  if (hasHeader) {
    result.headers = parseCsvLine(lines[0], delimiter).map((h) => (trimValues ? h.trim() : h));
    startIndex = 1;
  } else if (options.headers) {
    result.headers = options.headers;
  }
  const headers = options.headers ?? result.headers;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    const rowNum = i + 1;
    if (skipEmptyRows && line.trim() === '') continue;

    try {
      const fields = parseCsvLine(line, delimiter);
      const record: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        const header = headers[j];
        let value: unknown = j < fields.length ? fields[j] : '';
        if (trimValues && typeof value === 'string') value = value.trim();
        if (value === '') {
          if (emptyValue === 'null') value = null;
          else if (emptyValue === 'undefined') value = undefined;
        }
        record[header] = value;
      }
      result.data.push(record as T);
    } catch (e) {
      result.errors.push({
        row: rowNum,
        message: `Failed to parse row: ${e instanceof Error ? e.message : String(e)}`,
        content: line,
      });
    }
  }

  return result;
}

/** Convenience: JSON array → CSV string. */
export function jsonToCsv<T extends Record<string, unknown>>(
  json: T[],
  options: CsvGenerateOptions = {},
): string {
  return generateCsv(json, options);
}

/** Convenience: CSV string → JSON array (drops parse metadata). */
export function csvToJson<T = Record<string, unknown>>(
  csv: string,
  options: CsvParseOptions = {},
): T[] {
  return parseCsv<T>(csv, options).data;
}
