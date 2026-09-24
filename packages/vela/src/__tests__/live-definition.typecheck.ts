import { defineLiveQuery, LiveInvalidates, LiveQuery } from '../live';
import type { LiveQueryContext } from '../live';

const idArgs = {
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
};
const countResult = {
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
};

const syncCount = defineLiveQuery({ name: 'sync', args: idArgs, result: countResult });
const asyncCount = defineLiveQuery({ name: 'async', args: idArgs, result: countResult });
const scopedCount = defineLiveQuery({ name: 'scoped', args: idArgs, result: countResult });

export class CheckedResolver {
  @LiveQuery(syncCount, {
    tags: (args) => [args.id],
    coalesceBy: (args, context) => `${args.id}:${context.clientId}`,
  })
  sync(args: { id: string }, _context: LiveQueryContext): { count: number } {
    return { count: args.id.length };
  }

  // Tags may derive from the subscribing gateway, whose rooms can share ids with another's.
  @LiveQuery(scopedCount, { tags: (args, context) => [`${context.path}#${args.id}`] })
  async gatewayScoped(args: { id: string }): Promise<{ count: number }> {
    return { count: args.id.length };
  }

  @LiveQuery(asyncCount, { tags: ['async'] })
  async asyncResult(args: { id: string }): Promise<{ count: number }> {
    return { count: args.id.length };
  }

  // @ts-expect-error Handler arguments must accept the parser's output.
  @LiveQuery(syncCount, { tags: ['bad'] })
  wrongArgs(_args: { id: number }): { count: number } {
    return { count: 1 };
  }

  // @ts-expect-error Handler results must agree with the declared result parser.
  @LiveQuery(syncCount, { tags: ['bad'] })
  wrongResult(_args: { id: string }): { count: string } {
    return { count: 'wrong' };
  }

  // @ts-expect-error The definition carries the name; a separate name argument is removed.
  @LiveQuery('sync', syncCount, { tags: ['bad'] })
  oldSignature(args: { id: string }): { count: number } {
    return { count: args.id.length };
  }
}

LiveQuery(syncCount, {
  // @ts-expect-error Typed callbacks cannot contradict the argument parser.
  tags: (args: { id: number }) => [String(args.id)],
});
LiveQuery(syncCount, {
  tags: ['bad'],
  // @ts-expect-error The shared args parser replaces options.parse.
  parse: (value: unknown) => value,
});

export class CheckedMutations {
  @LiveInvalidates(['counts'])
  create(): { id: string } {
    return { id: 'c1' };
  }

  @LiveInvalidates((result: { removed: boolean }) => (result.removed ? ['counts'] : []), {
    room: (result) => (result.removed ? 'default' : undefined),
  })
  async remove(_id: string): Promise<{ removed: boolean }> {
    return { removed: true };
  }

  // @ts-expect-error A tags callback must accept the handler's result.
  @LiveInvalidates((result: { removed: boolean }) => (result.removed ? ['counts'] : []))
  count(): { count: number } {
    return { count: 1 };
  }
}

// @ts-expect-error Tags are strings.
LiveInvalidates([1]);
