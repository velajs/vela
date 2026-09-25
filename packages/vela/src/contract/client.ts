import type { Hono } from 'hono';
import type { BlankEnv } from 'hono/types';
import type { JSONParsed } from 'hono/utils/types';
import type { SchemaInput, SchemaOutput, ValidationSchema } from '../validation/parse-schema';
import type { RouteContract } from './route-contract';

// Type-level `hc` client contracts, mirroring what `vela client generate`
// emits for the same routes: wire values are strings (string literal unions
// stay literal), files are `File | Blob`, JSON bodies are the schema input and
// responses the JSON-parsed schema output.

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type Wire<T> = [T] extends [string] ? T : string;
type FormField<T> = [T] extends [Blob] ? File | Blob : Wire<T>;

type ParamName<Segment extends string> = Segment extends `${infer Name}{${string}`
  ? Name
  : Segment extends `${infer Name}?`
    ? Name
    : Segment;

type PathParams<Path extends string> = Path extends `${string}:${infer Segment}/${infer Rest}`
  ? ParamName<Segment> | PathParams<`/${Rest}`>
  : Path extends `${string}:${infer Segment}`
    ? ParamName<Segment>
    : never;

type QueryWire<T> = {
  [K in keyof T]: NonNullable<T[K]> extends readonly unknown[]
    ? Array<Wire<NonNullable<T[K]>[number]>>
    : Wire<NonNullable<T[K]>>;
};

type FormWire<T> = {
  [K in keyof T]: NonNullable<T[K]> extends readonly unknown[]
    ? Array<FormField<NonNullable<T[K]>[number]>>
    : FormField<NonNullable<T[K]>>;
};

type Group<Key extends string, T, Required extends boolean> = Required extends true
  ? { [P in Key]: T }
  : { [P in Key]?: T };

type ContractPath<C> = C extends { readonly path: infer Path extends string } ? Path : never;

type ParamInput<C> = C extends { readonly params: infer S extends ValidationSchema }
  ? { param: { [K in keyof SchemaInput<S>]-?: Wire<NonNullable<SchemaInput<S>[K]>> } }
  : [PathParams<ContractPath<C>>] extends [never]
    ? {}
    : { param: { [K in PathParams<ContractPath<C>>]: string } };

type QueryInput<C> = C extends { readonly query: infer S extends ValidationSchema }
  ? Group<'query', QueryWire<SchemaInput<S>>, {} extends SchemaInput<S> ? false : true>
  : {};

type BodyInput<C> = C extends { readonly body: infer S extends ValidationSchema }
  ? C extends { readonly form: object } | { readonly multipart: object }
    ? Group<
        'form',
        FormWire<NonNullable<SchemaInput<S>>>,
        undefined extends SchemaInput<S> ? false : true
      >
    : Group<'json', SchemaInput<S>, undefined extends SchemaInput<S> ? false : true>
  : {};

/** The `hc` input of a route contract. */
export type ContractInput<C extends RouteContract> = Simplify<
  ParamInput<C> & QueryInput<C> & BodyInput<C>
>;

/** The body an `hc` client reads from a route contract's success response. */
export type ContractOutput<C extends RouteContract> = C extends { readonly format: 'binary' }
  ? Blob
  : C extends { readonly format: 'stream' }
    ? ReadableStream<Uint8Array> | null
    : C extends { readonly format: 'response' }
      ? unknown
      : C extends { readonly response: null }
        ? never
        : C extends { readonly response: infer S extends ValidationSchema }
          ? C extends { readonly format: 'text' }
            ? Extract<SchemaOutput<S>, string> extends never
              ? string
              : Extract<SchemaOutput<S>, string>
            : JSONParsed<SchemaOutput<S>>
          : C extends { readonly format: 'text' }
            ? string
            : unknown;

/** The success status of a route contract: 201 for POST, 204 for `response: null`, else 200. */
export type ContractStatus<C extends RouteContract> = C extends {
  readonly status: infer Status extends number;
}
  ? Status
  : C extends { readonly response: null }
    ? 204
    : C extends { readonly method: 'POST' }
      ? 201
      : 200;

/** One `hc` endpoint for a route contract (a type literal, as Hono's `Schema` requires). */
export type ContractEndpoint<C extends RouteContract> = {
  input: ContractInput<C>;
  output: ContractOutput<C>;
  outputFormat: C extends { readonly format: infer Format extends string } ? Format : 'json';
  status: ContractStatus<C>;
};

/** The Hono schema of a union of route contracts, keyed by path and `$method`. */
export type ContractSchema<Routes extends RouteContract> = {
  [Path in ContractPath<Routes>]: {
    [Route in Routes as Route extends { readonly path: Path }
      ? `$${Lowercase<Route['method']>}`
      : never]: ContractEndpoint<Route>;
  };
};

type RoutesOf<Routes> = Routes extends readonly (infer Route)[] ? Route : Routes[keyof Routes];

/**
 * An `hc` application type built from route contracts — a tuple or a record
 * of `defineRoute` results with paths. It imports no server code.
 *
 * @example
 * ```ts
 * import { hc } from 'hono/client';
 * const client = hc<ContractApp<typeof routes>>('https://api.example.com');
 * const created = await client.api.todos.$post({ json: { title: 'Ship' } });
 * ```
 */
export type ContractApp<
  Routes extends readonly RouteContract[] | Readonly<Record<string, RouteContract>>,
> = Hono<BlankEnv, ContractSchema<Extract<RoutesOf<Routes>, RouteContract>>, '/'>;

/** The validated body a handler serving the contract receives. */
export type ContractBody<C extends RouteContract> = C extends {
  readonly body: infer S extends ValidationSchema;
}
  ? SchemaOutput<S>
  : undefined;

/** The validated query a handler serving the contract receives. */
export type ContractQuery<C extends RouteContract> = C extends {
  readonly query: infer S extends ValidationSchema;
}
  ? SchemaOutput<S>
  : Record<string, string | string[]>;

/** The validated path parameters a handler serving the contract receives. */
export type ContractParams<C extends RouteContract> = C extends {
  readonly params: infer S extends ValidationSchema;
}
  ? SchemaOutput<S>
  : { [K in PathParams<ContractPath<C>>]: string };

/** The response body the contract sends, after its schema parsed the handler's result. */
export type ContractResponse<C extends RouteContract> = C extends {
  readonly response: infer S extends ValidationSchema;
}
  ? SchemaOutput<S>
  : unknown;
