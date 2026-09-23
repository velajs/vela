import type { StandardSchemaV1 } from '@velajs/vela/validation';

export interface CrudContracts {
  id?: StandardSchemaV1;
  /** Explicit partial-create contract for validators without schema operations. */
  clone?: StandardSchemaV1;
  create?: StandardSchemaV1;
  update?: StandardSchemaV1;
  upsert?: StandardSchemaV1;
  row?: StandardSchemaV1;
  response?: StandardSchemaV1;
}

export type ContractInput<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
export type ContractOutput<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

export interface CrudFieldMetadata {
  type: 'string' | 'number' | 'boolean' | 'date' | 'unknown';
  nullable?: boolean;
  optional?: boolean;
}

/** Retains the concrete schemas so transformed input and output stay distinct. */
export function defineCrudContracts<const C extends CrudContracts>(contracts: C): Readonly<C> {
  return Object.freeze({ ...contracts });
}
