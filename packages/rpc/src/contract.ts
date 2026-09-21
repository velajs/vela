import type { SchemaInput, SchemaOutput, ValidationSchema } from '@velajs/vela/validation';
import { isProcedureName } from './protocol';

export interface Procedure<
  Name extends string,
  Input extends ValidationSchema,
  Output extends ValidationSchema,
> {
  readonly name: Name;
  readonly input: Input;
  readonly output: Output;
  /** Declares that repeating a call has the same intended effect. No automatic deduplication. */
  readonly idempotent: boolean;
}
export type AnyProcedure = Procedure<string, ValidationSchema, ValidationSchema>;
/** Client sends the original wire value, not the transformed input. */
export type ProcedureWireInput<P extends AnyProcedure> = SchemaInput<P['input']>;
/** Handler receives the validated/transformed input. */
export type ProcedureInput<P extends AnyProcedure> = SchemaOutput<P['input']>;
/** Handler returns the input of the output projection/schema. */
export type ProcedureResult<P extends AnyProcedure> = SchemaInput<P['output']>;
/** Result after server output parsing/projection. Must be JSON for this transport. */
export type ProcedureOutput<P extends AnyProcedure> = SchemaOutput<P['output']>;

export function defineProcedure<
  const Name extends `${string}.${string}`,
  Input extends ValidationSchema,
  Output extends ValidationSchema,
>(definition: {
  name: Name;
  input: Input;
  output: Output;
  idempotent?: boolean;
}): Procedure<Name, Input, Output> {
  if (!isProcedureName(definition.name))
    throw new TypeError('RPC procedure names must contain dot-separated identifier segments');
  if (definition.idempotent !== undefined && typeof definition.idempotent !== 'boolean')
    throw new TypeError('RPC idempotent must be a boolean');
  return Object.freeze({ ...definition, idempotent: definition.idempotent ?? false });
}
