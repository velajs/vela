/**
 * A minimal, dependency-free projection of the Standard Schema v1 contract
 * (https://standardschema.dev). Any validation library that exposes a
 * `~standard` property — zod 3.24+, valibot, arktype, … — is assignable to this
 * interface, so {@link import('./identity-contract').defineIdentity} can accept a
 * caller's schema without this package taking a runtime dependency on any
 * validator. The shapes are declared by hand from the public spec, not imported.
 */

/** A validated value, or the issues that made validation fail. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/** One reported validation problem. `path` locates it inside the input, when known. */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/**
 * The `~standard` payload a schema publishes. `validate` may run synchronously
 * (the common case for object schemas) or return a promise; consumers must be
 * ready for both.
 */
export interface StandardProps<Input, Output> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

/** A Standard Schema v1 validator. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardProps<Input, Output>;
}

/** Recover the validated (output) type a schema produces. */
export type InferStandardOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema['~standard']['types']
>['output'];
