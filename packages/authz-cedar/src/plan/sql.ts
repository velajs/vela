import type { EntityRef } from '../cedar/uid';
import type { PlanNode, PlanValue } from './plan';
/** Structurally compatible with Vela CRUD predicates without a runtime dependency. */
export type SqlPredicate =
  | { op: 'true' | 'false' }
  | { op: 'and' | 'or'; args: readonly SqlPredicate[] }
  | { op: 'not'; arg: SqlPredicate }
  | { op: 'isNull'; field: string }
  | {
      op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
      field: string;
      value: string | number | boolean | null;
    }
  | { op: 'in'; field: string; values: readonly (string | number | boolean | null)[] }
  | { op: 'pattern'; field: string; tokens: readonly (string | null)[] };
export interface CedarColumn {
  field: string;
  kind: 'string' | 'long' | 'bool' | 'entity';
  entityType?: string;
}
export interface CedarSqlMapping {
  resourceType: string;
  id: string;
  attributes: Readonly<Record<string, CedarColumn>>;
  /** Must enumerate descendant-or-self IDs from an authoritative operation snapshot. */
  hierarchy?: (input: {
    attribute: string | null;
    parent: EntityRef;
    resourceType: string;
  }) => readonly string[];
}
function literal(value: PlanValue, column: CedarColumn): string | number | boolean {
  if (value.kind !== column.kind) throw new TypeError('Cedar/column type mismatch');
  switch (value.kind) {
    case 'string':
    case 'bool':
      return value.value;
    case 'long': {
      const number = Number(value.value);
      if (!Number.isSafeInteger(number)) throw new TypeError('Unsafe Cedar integer');
      return number;
    }
    case 'entity':
      if (value.value.type !== column.entityType) throw new TypeError('Cedar entity type mismatch');
      return value.value.id;
    default:
      throw new TypeError('Unsupported Cedar SQL value');
  }
}
export function cedarPredicate(node: PlanNode, mapping: CedarSqlMapping): SqlPredicate {
  const column = (attr: { root: string; path: readonly string[] } | null): CedarColumn => {
    if (attr === null)
      return { field: mapping.id, kind: 'entity', entityType: mapping.resourceType };
    if (attr.root !== 'resource' || attr.path.length !== 1)
      throw new TypeError('Only mapped resource attributes can be queried');
    const result = mapping.attributes[attr.path[0]!];
    if (!result) throw new TypeError(`Unmapped Cedar attribute '${attr.path[0]}'`);
    return result;
  };
  const visit = (p: PlanNode): SqlPredicate => {
    switch (p.op) {
      case 'true':
      case 'false':
        return { op: p.op };
      case 'and':
      case 'or':
        return { op: p.op, args: p.nodes.map(visit) };
      case 'not':
        return { op: 'not', arg: visit(p.node) };
      case 'isType':
        return { op: p.entityType === mapping.resourceType ? 'true' : 'false' };
      case 'exists':
        return { op: 'not', arg: { op: 'isNull', field: column(p.attr).field } };
      case 'cmp': {
        const c = column(p.attr),
          value = literal(p.value, c);
        const leaf: SqlPredicate = { op: p.cmp === 'ne' ? 'eq' : p.cmp, field: c.field, value };
        return p.cmp === 'ne'
          ? {
              op: 'and',
              args: [
                { op: 'not', arg: { op: 'isNull', field: c.field } },
                { op: 'not', arg: leaf },
              ],
            }
          : leaf;
      }
      case 'in': {
        const c = column(p.attr);
        return { op: 'in', field: c.field, values: p.values.map((v) => literal(v, c)) };
      }
      case 'like': {
        const c = column(p.attr);
        if (c.kind !== 'string') throw new TypeError('Cedar like requires a string column');
        const tokens = p.pattern.map((t) => ('literal' in t ? t.literal : null));
        if (tokens.some((t) => t?.includes('\0')))
          throw new TypeError('NUL patterns are unsupported');
        return { op: 'pattern', field: c.field, tokens };
      }
      case 'inHierarchy': {
        if (!mapping.hierarchy)
          throw new TypeError('An authoritative hierarchy mapping is required');
        const c = column(p.attr);
        if (c.kind !== 'entity') throw new TypeError('Hierarchy requires an entity column');
        const values = mapping.hierarchy({
          attribute: p.attr?.path[0] ?? null,
          parent: p.parent,
          resourceType: c.entityType!,
        });
        if (values.length > 1000 || !values.every((id) => typeof id === 'string'))
          throw new TypeError('Invalid or oversized hierarchy expansion');
        return { op: 'in', field: c.field, values };
      }
      default:
        throw new TypeError(`Unsupported Cedar SQL expression '${p.op}'`);
    }
  };
  return visit(node);
}
export function cedarCrudPlan(
  plan: { kind: 'ALWAYS_ALLOW' | 'ALWAYS_DENY' | 'CONDITIONAL'; condition: PlanNode },
  mapping: CedarSqlMapping,
): { kind: 'allow' } | { kind: 'deny' } | { kind: 'conditional'; predicate: SqlPredicate } {
  if (plan.kind === 'ALWAYS_DENY') return { kind: 'deny' };
  if (plan.kind === 'ALWAYS_ALLOW') return { kind: 'allow' };
  return { kind: 'conditional', predicate: cedarPredicate(plan.condition, mapping) };
}
/** Parameterized SQL for users of a database driver without Vela CRUD. */
export function compileCedarSql(
  node: PlanNode,
  mapping: CedarSqlMapping,
  dialect: 'sqlite' | 'pg',
): { sql: string; params: (string | number | boolean | null)[] } {
  const predicate = cedarPredicate(node, mapping),
    params: (string | number | boolean | null)[] = [];
  const bind = (v: string | number | boolean | null) => {
    params.push(dialect === 'sqlite' && typeof v === 'boolean' ? Number(v) : v);
    return dialect === 'pg' ? `$${params.length}` : '?';
  };
  const col = (field: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new TypeError('Invalid SQL column');
    return `"${field}"`;
  };
  const render = (p: SqlPredicate): string => {
    switch (p.op) {
      case 'true':
        return 'TRUE';
      case 'false':
        return 'FALSE';
      case 'and':
      case 'or':
        return p.args.length
          ? `(${p.args.map(render).join(p.op === 'and' ? ' AND ' : ' OR ')})`
          : p.op === 'and'
            ? 'TRUE'
            : 'FALSE';
      case 'not':
        return `(NOT ${render(p.arg)})`;
      case 'isNull':
        return `${col(p.field)} IS NULL`;
      case 'in':
        return p.values.length
          ? `(${p.values.map((value) => render({ op: 'eq', field: p.field, value })).join(' OR ')})`
          : 'FALSE';
      case 'pattern': {
        const pattern = p.tokens
          .map((token) =>
            token === null
              ? dialect === 'sqlite'
                ? '*'
                : '%'
              : dialect === 'sqlite'
                ? token.replace(/\[/g, '[[]').replace(/\*/g, '[*]').replace(/\?/g, '[?]')
                : token.replace(/[!%_]/g, '!$&'),
          )
          .join('');
        return `COALESCE(${col(p.field)} ${dialect === 'sqlite' ? 'GLOB' : 'LIKE'} ${bind(pattern)}${dialect === 'pg' ? " ESCAPE '!'" : ''}, FALSE)`;
      }
      default: {
        const operator = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[p.op];
        return `COALESCE(${col(p.field)} ${operator} ${bind(p.value)}, FALSE)`;
      }
    }
  };
  return { sql: render(predicate), params };
}
