import { defineLiveQuery } from '../query';
import type { LiveQueryDefinition } from '../query';

const definition = defineLiveQuery({
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
const inferred: LiveQueryDefinition<{ id: string }, { count: number }> = definition;
void inferred;

// @ts-expect-error A query definition must include its result parser.
defineLiveQuery({ args: { parse: (value: unknown) => value } });
// @ts-expect-error The result parser determines the result type.
const mismatched: LiveQueryDefinition<{ id: string }, { count: string }> = definition;
void mismatched;
