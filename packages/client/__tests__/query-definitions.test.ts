import { describe, expect, expectTypeOf, it } from 'vitest';
import { createLiveClient, defineLiveQuery, LiveClient, VelaLiveError } from '../src';
import type { InferLiveContract, LiveQueryDefinitions } from '../src';
import { emptyArgs, emptyListSchema, idRows, listArgs, otherListSchema } from './schema-fixtures';
import { makeSocketFactory, tick } from './harness';

const listById = defineLiveQuery({
  name: 'todos.byList',
  args: { parse: listArgs },
  result: { parse: idRows },
});
const queries = [emptyListSchema, listById] as const;

describe('named live query definitions', () => {
  it('subscribes with the name each definition declares', async () => {
    const sockets = makeSocketFactory();
    const client = createLiveClient({
      url: 'https://api.test',
      queries,
      WebSocket: sockets.factory,
    });
    try {
      client.subscribe('todos.byList', { listId: 'l1' }, (rows) => {
        expectTypeOf(rows).toEqualTypeOf<{ id: string }[] | undefined>();
      });
      await tick();
      sockets.last().open();
      expect(sockets.last().liveFrames()).toContainEqual(
        expect.objectContaining({ t: 'sub', query: 'todos.byList', args: { listId: 'l1' } }),
      );
    } finally {
      client.close();
    }
  });

  it('rejects two definitions that declare the same name', () => {
    const duplicate = defineLiveQuery({
      name: 'todos.list',
      args: { parse: emptyArgs },
      result: { parse: idRows },
    });
    expect(
      () => new LiveClient({ url: 'https://api.test', queries: [emptyListSchema, duplicate] }),
    ).toThrow(VelaLiveError);
    expect(
      () => new LiveClient({ url: 'https://api.test', queries: [emptyListSchema, duplicate] }),
    ).toThrow(/todos\.list/);
  });
});

// Type-level contract: the definitions' names and parsers type the client.
function contractTypes(): void {
  type Contract = InferLiveContract<typeof queries>;
  expectTypeOf<Contract>().toEqualTypeOf<{
    'todos.list': { args: Record<string, never>; result: { id: string }[] };
    'todos.byList': { args: { listId: string }; result: { id: string }[] };
  }>();

  const client = createLiveClient({ url: 'https://api.test', queries });
  expectTypeOf(client).toEqualTypeOf<LiveClient<Contract>>();
  // @ts-expect-error The definitions control query names.
  client.subscribe('missing', {}, () => {});
  // @ts-expect-error Arguments follow the definition's parser.
  client.subscribe('todos.byList', { listId: 1 }, () => {});

  type Rows = { args: Record<string, never>; result: { id: string }[] };
  const explicit: LiveQueryDefinitions<{ 'other.list': Rows }> = [otherListSchema];
  void explicit;
  // @ts-expect-error A definition must name a query of the contract.
  const misnamed: LiveQueryDefinitions<{ 'todos.list': Rows }> = [otherListSchema];
  void misnamed;
}
void contractTypes;
