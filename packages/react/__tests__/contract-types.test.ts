import { todoSchema } from '../../client/__tests__/schema-fixtures';
import { expect, expectTypeOf, it } from 'vitest';
import { createElement } from 'react';
import { LiveClient } from '@velajs/client';
import { createLiveHooks } from '../src';

interface AppLive {
  'todos.list': { args: { listId: string }; result: { id: string }[] };
}
interface OtherLive {
  'orders.list': { args: { account: number }; result: number[] };
}
const hooks = createLiveHooks<AppLive>();

it('creates an application-specific provider and hooks without erasing its contract', () => {
  const client = new LiveClient<AppLive>({
    queries: [todoSchema],
    url: 'https://api.test',
  });
  expect(createElement(hooks.LiveProvider, { client }).props.client).toBe(client);
  client.close();
});

function checkedComponent(): void {
  const data = hooks.useLiveQuery('todos.list', { listId: 'l1' });
  expectTypeOf(data).toEqualTypeOf<{ id: string }[] | undefined>();
  expectTypeOf(hooks.useLiveClient()).toEqualTypeOf<LiveClient<AppLive>>();
  // @ts-expect-error query must belong to the bound provider contract
  hooks.useLiveQuery('orders.list', { account: 1 });
  // @ts-expect-error wrong arguments
  hooks.useLiveQuery('todos.list', { listId: 42 });
  // @ts-expect-error caller cannot choose a different context contract
  hooks.useLiveClient<OtherLive>();
  const other = new LiveClient<OtherLive>({
    url: 'https://api.test',
    queries: [
      {
        name: 'orders.list',
        args: { parse: () => ({ account: 1 }) },
        result: { parse: () => [1] },
      },
    ],
  });
  // @ts-expect-error incompatible provider client
  createElement(hooks.LiveProvider, { client: other });
  // @ts-expect-error result type without a parser is not supported
  hooks.useLiveMutation<{ id: string }>('/todos');
}
void checkedComponent;
