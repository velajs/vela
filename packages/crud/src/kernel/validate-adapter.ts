import { validateSchema, type StandardSchemaV1 } from '@velajs/vela';
import type { RuntimeAdapter } from '../adapter/contract';

type Row = Record<string, unknown>;

/** Validate database results at the schema boundary before policies/hooks see them.
 * Passthrough retains managed, computed and driver extension fields as unknown. */
export function validateAdapterRows(
  adapter: RuntimeAdapter,
  schema: StandardSchemaV1,
): RuntimeAdapter {
  const row = async (value: unknown): Promise<Row> => {
    const parsed = await validateSchema(schema, value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new TypeError('Persisted row must be a record');
    return Object.fromEntries(Object.entries(parsed));
  };
  const nullable = async (value: unknown): Promise<Row | null> =>
    value === null ? null : row(value);
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
      return { ...page, result: await Promise.all(page.result.map(row)) };
    },
    ...(restore
      ? { restore: async (...args: Parameters<typeof restore>) => nullable(await restore(...args)) }
      : {}),
    ...(createMany
      ? {
          createMany: async (...args: Parameters<typeof createMany>) =>
            Promise.all((await createMany(...args)).map(row)),
        }
      : {}),
    ...(upsertOne
      ? {
          upsertOne: async (...args: Parameters<typeof upsertOne>) => {
            const result = await upsertOne(...args);
            return { ...result, row: await row(result.row) };
          },
        }
      : {}),
    ...(updateWhere
      ? {
          updateWhere: async (...args: Parameters<typeof updateWhere>) => {
            const result = await updateWhere(...args);
            return {
              ...result,
              records: result.records ? await Promise.all(result.records.map(row)) : undefined,
            };
          },
        }
      : {}),
    ...(search
      ? {
          search: async (...args: Parameters<typeof search>) =>
            Promise.all(
              (await search(...args)).map(async (hit) => ({
                ...hit,
                record: await row(hit.record),
              })),
            ),
        }
      : {}),
  };
}
