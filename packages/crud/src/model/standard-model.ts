import { z, type ZodType } from 'zod';
import type { StandardSchemaV1 } from '@velajs/vela/validation';
import type { CrudContracts, CrudFieldMetadata } from '../schema/contracts';
import { defineModel } from './define-model';
import type { ModelConfig, Model } from './model.types';

type OperationContracts = CrudContracts & { create: StandardSchemaV1; update: StandardSchemaV1 };
export interface StandardModelConfig<
  S extends StandardSchemaV1,
  C extends OperationContracts = OperationContracts,
> extends Omit<ModelConfig, 'schema' | 'resolveSchema'> {
  schema: S;
  fields: Readonly<
    Record<Extract<keyof StandardSchemaV1.InferOutput<S>, string>, CrudFieldMetadata>
  >;
  contracts: C;
}

export type StandardModel<
  S extends StandardSchemaV1,
  C extends OperationContracts = OperationContracts,
> = Model & {
  readonly contracts: Readonly<Omit<C, 'row'> & { row: S }>;
};

/** Explicit metadata replaces schema introspection for validators other than Zod.
 * The internal field schema only validates field mechanics; row/input contracts
 * always run the caller's validator, including async refinements and transforms. */
export function defineStandardModel<S extends StandardSchemaV1, const C extends OperationContracts>(
  config: StandardModelConfig<S, C>,
): StandardModel<S, C> {
  const shape: Record<string, ZodType> = {};
  for (const [name, field] of Object.entries<CrudFieldMetadata>(config.fields)) {
    let schema: ZodType =
      field.type === 'string'
        ? z.string()
        : field.type === 'number'
          ? z.number()
          : field.type === 'boolean'
            ? z.boolean()
            : field.type === 'date'
              ? z.date()
              : z.unknown();
    if (field.nullable) schema = schema.nullable();
    if (field.optional) schema = schema.optional();
    shape[name] = schema;
  }
  const model = defineModel({ ...config, schema: z.object(shape) });
  return {
    ...model,
    fields: Object.freeze(
      Object.fromEntries(
        Object.entries<CrudFieldMetadata>(config.fields).map(([key, value]) => [
          key,
          Object.freeze({ ...value }),
        ]),
      ),
    ),
    contracts: Object.freeze({ ...config.contracts, row: config.schema }),
  };
}
