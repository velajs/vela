import { expect, it } from 'vitest';
import { bindAdapter } from '../../adapter/contract';
import {
  crudTransaction,
  withCrudTransactionStore,
  type CrudTransactionScope,
} from '../transaction';

function fixture() {
  const owner = {};
  let committed = false;
  const adapter = bindAdapter({
    transactionOwner: owner,
    capabilities: new Set(['transactions']),
    requestScope: async (fn) => fn({ tx: undefined }),
    transaction: async (fn) => {
      const result = await fn({ tx: owner });
      committed = true;
      return result;
    },
    create: async () => ({}),
    readOne: async () => null,
    update: async () => null,
    delete: async () => null,
    list: async () => {
      throw new Error('unused');
    },
  });
  const binding = { owner, bind: () => ({ value: async () => 42 }) };
  return { adapter, binding, committed: () => committed };
}

it('joins a same-owner store and rejects a retained transaction', async () => {
  const { adapter, binding, committed } = fixture();
  let retained!: CrudTransactionScope;
  expect(
    await crudTransaction(adapter, { tenantId: 'one' }, async (tx) => {
      retained = tx;
      return withCrudTransactionStore(tx, binding, { tenantId: 'one' }, (store) => store.value());
    }),
  ).toBe(42);
  expect(committed()).toBe(true);
  await expect(
    withCrudTransactionStore(retained, binding, { tenantId: 'one' }, (store) => store.value()),
  ).rejects.toThrow('Expired');
});

it.each(['owner', 'tenant', 'binding', 'operation'])(
  'poisons the transaction on a caught %s error',
  async (kind) => {
    const { adapter, binding, committed } = fixture();
    await expect(
      crudTransaction(adapter, { tenantId: 'one' }, async (tx) => {
        await withCrudTransactionStore(
          tx,
          kind === 'owner'
            ? { ...binding, owner: {} }
            : kind === 'binding'
              ? {
                  ...binding,
                  bind() {
                    throw new Error('bad binding');
                  },
                }
              : binding,
          { tenantId: kind === 'tenant' ? 'two' : 'one' },
          async () => {
            if (kind === 'operation') throw new Error('write failed');
          },
        ).catch(() => undefined);
      }),
    ).rejects.toThrow('rolled back');
    expect(committed()).toBe(false);
  },
);

it('rejects an unawaited store callback and prevents commit', async () => {
  const { adapter, binding, committed } = fixture();
  await expect(
    crudTransaction(adapter, {}, async (tx) => {
      void withCrudTransactionStore(tx, binding, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }),
  ).rejects.toThrow('rolled back');
  expect(committed()).toBe(false);
});

it('rolls back when a bound store reports an error caught inside the helper callback', async () => {
  const { adapter, binding, committed } = fixture();
  await expect(
    crudTransaction(adapter, {}, async (tx) => {
      await withCrudTransactionStore(
        tx,
        {
          owner: binding.owner,
          bind(_scope, _context, onError) {
            return {
              async complete() {
                const error = new Error('lease lost');
                onError(error);
                throw error;
              },
            };
          },
        },
        {},
        async (store) => {
          await store.complete().catch(() => undefined);
        },
      );
    }),
  ).rejects.toThrow('rolled back');
  expect(committed()).toBe(false);
});
