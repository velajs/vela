import { isValidationSchema } from '../validation/parse-schema';
import type { SchemaInput, SchemaOutput, ValidationSchema } from '../validation/parse-schema';

/** A named, runtime-validated event contract. Keep definitions shared by emitters and listeners. */
export interface EventDefinition<
  Name extends string = string,
  Schema extends ValidationSchema = ValidationSchema,
> {
  readonly name: Name;
  readonly schema: Schema;
}

export type EventInput<Event extends EventDefinition> = SchemaInput<Event['schema']>;
export type EventPayload<Event extends EventDefinition> = SchemaOutput<Event['schema']>;

export function defineEvent<const Name extends string, Schema extends ValidationSchema>(
  name: Name,
  schema: Schema,
): EventDefinition<Name, Schema> {
  if (typeof name !== 'string' || name.trim().length === 0 || name.includes('*')) {
    throw new TypeError('An event definition requires a non-empty exact event name');
  }
  if (!isValidationSchema(schema))
    throw new TypeError('An event definition requires a validation schema');
  return Object.freeze({ name, schema });
}

export type EventVocabulary<Schemas extends Record<string, ValidationSchema>> = {
  readonly [Name in keyof Schemas & string]: EventDefinition<Name, Schemas[Name]>;
};

/** Define an application-owned vocabulary; each property retains its schema input/output types. */
export function defineEventVocabulary<const Schemas extends Record<string, ValidationSchema>>(
  schemas: Schemas,
): EventVocabulary<Schemas> {
  const definitions: Record<string, EventDefinition> = Object.create(null);
  for (const [name, schema] of Object.entries(schemas))
    definitions[name] = defineEvent(name, schema);
  // Each entry is built from exactly the matching key and schema above.
  return Object.freeze(definitions) as EventVocabulary<Schemas>;
}
