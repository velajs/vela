/** A portable, two-valued predicate. Missing fields are distinct from null. */
export type PredicateValue = string | number | boolean | null;
export type QueryPredicate =
  | { op: 'and' | 'or'; args: readonly QueryPredicate[] }
  | { op: 'not'; arg: QueryPredicate }
  | { op: 'true' | 'false' }
  | { op: 'has' | 'isNull'; field: string }
  | {
      op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'startsWith' | 'endsWith';
      field: string;
      value: PredicateValue;
    }
  | { op: 'in'; field: string; values: readonly PredicateValue[] }
  | { op: 'pattern'; field: string; tokens: readonly (string | null)[] };

/** Validates foreign translators before any adapter executes a query. */
export function validatePredicate(
  value: unknown,
  fields?: ReadonlySet<string>,
  depth = 0,
): QueryPredicate {
  if (depth > 32 || !value || typeof value !== 'object' || !('op' in value))
    throw new TypeError('Invalid query predicate');
  const next = (v: unknown) => validatePredicate(v, fields, depth + 1);
  switch (value.op) {
    case 'true':
    case 'false':
      return Object.freeze({ op: value.op });
    case 'and':
    case 'or':
      if (!('args' in value) || !Array.isArray(value.args) || value.args.length > 1000)
        throw new TypeError('Invalid predicate arguments');
      return Object.freeze({ op: value.op, args: Object.freeze(value.args.map(next)) });
    case 'not':
      if (!('arg' in value)) throw new TypeError('Invalid negation');
      return Object.freeze({ op: 'not', arg: next(value.arg) });
    default:
      break;
  }
  if (
    !('field' in value) ||
    typeof value.field !== 'string' ||
    !value.field ||
    (fields && !fields.has(value.field))
  )
    throw new TypeError('Unknown predicate field');
  const field = value.field;
  switch (value.op) {
    case 'has':
    case 'isNull':
      return Object.freeze({ op: value.op, field });
    case 'pattern':
      if (
        !('tokens' in value) ||
        !Array.isArray(value.tokens) ||
        value.tokens.length > 1000 ||
        !value.tokens.every((v) => v === null || (typeof v === 'string' && !v.includes('\0')))
      )
        throw new TypeError('Invalid pattern predicate');
      return Object.freeze({ op: 'pattern', field, tokens: Object.freeze([...value.tokens]) });
    case 'in':
      if (!('values' in value) || !Array.isArray(value.values) || value.values.length > 1000)
        throw new TypeError('Invalid set predicate');
      return Object.freeze({
        op: 'in',
        field,
        values: Object.freeze(value.values.map(predicateValue)),
      });
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (!('value' in value)) throw new TypeError('Missing predicate value');
      const v = predicateValue(value.value);
      if (['contains', 'startsWith', 'endsWith'].includes(value.op) && typeof v !== 'string')
        throw new TypeError('String predicate requires string');
      return Object.freeze({ op: value.op, field, value: v });
    }
    default:
      throw new TypeError('Unsupported predicate expression');
  }
}
function predicateValue(v: unknown): PredicateValue {
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v))
  )
    return v;
  throw new TypeError('Invalid predicate value');
}
export function matchesPredicate(
  row: Readonly<Record<string, unknown>>,
  p: QueryPredicate,
): boolean {
  switch (p.op) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'and':
      return p.args.every((v) => matchesPredicate(row, v));
    case 'or':
      return p.args.some((v) => matchesPredicate(row, v));
    case 'not':
      return !matchesPredicate(row, p.arg);
    case 'has':
      return Object.hasOwn(row, p.field) && row[p.field] !== undefined;
    case 'isNull':
      return row[p.field] === null;
    case 'pattern': {
      const value = row[p.field];
      if (typeof value !== 'string') return false;
      const pattern = p.tokens
        .map((t) => (t === null ? '[\\s\\S]*' : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('');
      // `$` also matches before a final newline. Require the actual end of input.
      return new RegExp(`^${pattern}(?![\\s\\S])`, 'u').test(value);
    }
    case 'in':
      return Object.hasOwn(row, p.field) && p.values.some((v) => row[p.field] === v);
    default: {
      const v = row[p.field];
      if (!Object.hasOwn(row, p.field) || v === undefined) return false;
      if (p.op === 'eq') return v === p.value;
      if (typeof v === 'string' && typeof p.value === 'string') {
        if (p.op === 'contains') return v.includes(p.value);
        if (p.op === 'startsWith') return v.startsWith(p.value);
        if (p.op === 'endsWith') return v.endsWith(p.value);
      }
      if (
        v === null ||
        p.value === null ||
        typeof v !== typeof p.value ||
        (typeof v !== 'number' && typeof v !== 'string')
      )
        return false;
      const b = p.value;
      if (typeof b !== 'number' && typeof b !== 'string') return false;
      switch (p.op) {
        case 'lt':
          return v < b;
        case 'lte':
          return v <= b;
        case 'gt':
          return v > b;
        case 'gte':
          return v >= b;
        default:
          return false;
      }
    }
  }
}
export function predicateFilter(predicate: QueryPredicate): {
  field: '';
  operator: 'predicate';
  value: QueryPredicate;
} {
  return { field: '', operator: 'predicate', value: validatePredicate(predicate) };
}
