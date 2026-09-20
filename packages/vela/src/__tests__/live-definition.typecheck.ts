import { defineLiveQuery, LiveQuery } from '../live';
import type { LiveQueryContext } from '../live';

const definition = defineLiveQuery({
  args: {
    parse(value: unknown): { id: string } {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('id' in value) ||
        typeof value.id !== 'string'
      ) {
        throw new TypeError('expected id');
      }
      return { id: value.id };
    },
  },
  result: {
    parse(value: unknown): { count: number } {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('count' in value) ||
        typeof value.count !== 'number'
      ) {
        throw new TypeError('expected count');
      }
      return { count: value.count };
    },
  },
});

export class CheckedResolver {
  @LiveQuery('sync', definition, {
    tags: (args) => [args.id],
    coalesceBy: (args, context) => `${args.id}:${context.clientId}`,
  })
  sync(args: { id: string }, _context: LiveQueryContext): { count: number } {
    return { count: args.id.length };
  }

  @LiveQuery('async', definition, { tags: ['async'] })
  async asyncResult(args: { id: string }): Promise<{ count: number }> {
    return { count: args.id.length };
  }

  // @ts-expect-error Handler arguments must accept the parser's output.
  @LiveQuery('wrong-args', definition, { tags: ['bad'] })
  wrongArgs(_args: { id: number }): { count: number } {
    return { count: 1 };
  }

  // @ts-expect-error Handler results must agree with the declared result parser.
  @LiveQuery('wrong-result', definition, { tags: ['bad'] })
  wrongResult(_args: { id: string }): { count: string } {
    return { count: 'wrong' };
  }

  // @ts-expect-error The old parser-less options-only signature is removed.
  @LiveQuery('old-signature', { tags: ['bad'] })
  oldSignature(): number {
    return 1;
  }
}

LiveQuery('wrong-tags', definition, {
  // @ts-expect-error Typed callbacks cannot contradict the argument parser.
  tags: (args: { id: number }) => [String(args.id)],
});
LiveQuery('old-parse-option', definition, {
  tags: ['bad'],
  // @ts-expect-error The shared args parser replaces options.parse.
  parse: (value: unknown) => value,
});
