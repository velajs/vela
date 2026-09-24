import { defineLiveQuery } from '../query';
import type { LiveQueryDefinition } from '../query';

const definition = defineLiveQuery({
  name: 'counters.byId',
  args: {
    parse(value: unknown) {
      if (typeof value !== 'string') throw new TypeError('expected string');
      return { id: value };
    },
  },
  result: {
    parse(value: unknown) {
      if (typeof value !== 'number') throw new TypeError('expected number');
      return { count: value };
    },
  },
});
const inferred: LiveQueryDefinition<'counters.byId', { id: string }, { count: number }> =
  definition;
void inferred;
const erased: LiveQueryDefinition = definition;
void erased;

// @ts-expect-error A query definition must include its result parser.
defineLiveQuery({ name: 'counters.byId', args: { parse: (value: unknown) => value } });
// @ts-expect-error A query definition declares its wire name.
defineLiveQuery({ args: definition.args, result: definition.result });
// @ts-expect-error The result parser determines the result type.
const mismatched: LiveQueryDefinition<'counters.byId', { id: string }, { count: string }> =
  definition;
void mismatched;
// @ts-expect-error The name is part of the definition's type.
const renamed: LiveQueryDefinition<'counters.all', { id: string }, { count: number }> = definition;
void renamed;
// @ts-expect-error The name is the first type argument: an `<Args, Result>` annotation fails.
const twoArguments: LiveQueryDefinition<{ id: string }, { count: number }> = definition;
void twoArguments;
// Migrate a two-argument annotation by naming the query first, or by `string`.
const migrated: LiveQueryDefinition<string, { id: string }, { count: number }> = definition;
void migrated;
