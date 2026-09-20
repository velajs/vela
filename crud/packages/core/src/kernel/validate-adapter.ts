import type { ZodObject, ZodRawShape } from 'zod';
import type { RuntimeAdapter } from '../adapter/contract';

type Row = Record<string, unknown>;

/** Validate database results at the schema boundary before policies/hooks see them.
 * Passthrough retains managed, computed and driver extension fields as unknown. */
export function validateAdapterRows(
  adapter: RuntimeAdapter,
  schema: ZodObject<ZodRawShape>,
): RuntimeAdapter {
  const rowSchema = schema.passthrough();
  const row = (value: unknown): Row => rowSchema.parse(value);
  const nullable = (value: unknown): Row | null => (value === null ? null : row(value));
  const { restore, createMany, upsertOne, updateWhere, search } = adapter;
  return {
    ...adapter,
    create: async (input, scope) => row(await adapter.create(input, scope)),
    readOne: async (lookup, options, scope) =>
      nullable(await adapter.readOne(lookup, options, scope)),
    update: async (lookup, patch, scope) => nullable(await adapter.update(lookup, patch, scope)),
    delete: async (lookup, options, scope) =>
      nullable(await adapter.delete(lookup, options, scope)),
    list: async (query, scope) => {
      const page = await adapter.list(query, scope);
      return { ...page, result: page.result.map(row) };
    },
    ...(restore
      ? { restore: async (...args: Parameters<typeof restore>) => nullable(await restore(...args)) }
      : {}),
    ...(createMany
      ? {
          createMany: async (...args: Parameters<typeof createMany>) =>
            (await createMany(...args)).map(row),
        }
      : {}),
    ...(upsertOne
      ? {
          upsertOne: async (...args: Parameters<typeof upsertOne>) => {
            const result = await upsertOne(...args);
            return { ...result, row: row(result.row) };
          },
        }
      : {}),
    ...(updateWhere
      ? {
          updateWhere: async (...args: Parameters<typeof updateWhere>) => {
            const result = await updateWhere(...args);
            return { ...result, records: result.records?.map(row) };
          },
        }
      : {}),
    ...(search
      ? {
          search: async (...args: Parameters<typeof search>) =>
            (await search(...args)).map((hit) => ({ ...hit, record: row(hit.record) })),
        }
      : {}),
  };
}
