/**
 * `defineEvents` — a typed vocabulary of event factories.
 *
 * You declare events grouped into namespaces; each leaf becomes a factory that
 * stamps out a fully-typed {@link InputEvent} with a namespace-qualified type
 * string (`"chat.messageSent"`) and an inferred payload. A type-only `_types`
 * map (qualified type → payload) is exposed for generic tooling and tests.
 *
 * Payload types come from either a **validator** or an explicit marker:
 *
 * - Any [Standard Schema](https://standardschema.dev) validator — zod (v3.24+
 *   / v4), valibot, arktype, … — is inferred structurally through its
 *   `~standard` metadata. This package neither imports nor depends on a
 *   validator; it only reads the phantom output type, so it stays zero-dep and
 *   works with whatever the app already uses.
 * - {@link payload | `payload<T>()`} for a schema-less, type-only payload.
 *
 * @module
 */

import type { InputEvent } from './seq';

/**
 * Minimal structural view of a Standard Schema validator — just enough to read
 * its inferred output type without depending on the spec package.
 */
export interface SchemaLike<Output = unknown> {
  readonly '~standard': {
    readonly types?: { readonly output: Output } | undefined;
  };
}

declare const PAYLOAD_TYPE: unique symbol;

/** A schema-less, type-only payload carrier produced by {@link payload}. */
export interface PayloadType<T> {
  readonly [PAYLOAD_TYPE]: T;
}

/** Declare a payload's type without attaching a runtime validator. */
export const payload = <T>(): PayloadType<T> => ({}) as PayloadType<T>;

type StandardOutput<T> = T extends { readonly '~standard': { readonly types?: infer Types } }
  ? NonNullable<Types> extends { readonly output: infer Output }
    ? Output
    : unknown
  : unknown;

/** Resolve the payload type of a single event definition leaf. */
export type InferPayload<T> =
  T extends PayloadType<infer P> ? P : T extends SchemaLike ? StandardOutput<T> : unknown;

type QualifiedType<Ns extends string, Name extends string> = `${Ns}.${Name}`;

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

/** A factory that builds an {@link InputEvent} for one declared event. */
export interface EventFactory<Type extends string, Payload> {
  (payload: Payload): InputEvent<Type, Payload>;
  /** The qualified event-type string this factory produces. */
  readonly type: Type;
}

/** The factories for one namespace. */
export type EventNamespace<Ns extends string, Events extends Record<string, unknown>> = {
  readonly [Name in keyof Events & string]: EventFactory<
    QualifiedType<Ns, Name>,
    InferPayload<Events[Name]>
  >;
};

/** Flattened, type-only map of qualified event type → payload shape. */
export type EventPayloadMap<Definition extends Record<string, Record<string, unknown>>> =
  UnionToIntersection<
    {
      [Ns in keyof Definition & string]: {
        [Name in keyof Definition[Ns] & string]: {
          readonly [K in QualifiedType<Ns, Name>]: InferPayload<Definition[Ns][Name]>;
        };
      }[keyof Definition[Ns] & string];
    }[keyof Definition & string]
  >;

/** The object {@link defineEvents} returns. */
export type EventsDefinition<Definition extends Record<string, Record<string, unknown>>> = {
  readonly [Ns in keyof Definition & string]: EventNamespace<Ns, Definition[Ns]>;
} & {
  /** Type-only map of qualified event type → payload. Empty `{}` at runtime. */
  readonly _types: EventPayloadMap<Definition>;
};

/**
 * Build a typed set of event factories from a namespaced definition.
 *
 * The factory does not validate at call time (an {@link InputEvent} is an
 * optimistic command; validate at the log boundary if you need to). It only
 * carries the payload type through and stamps the qualified `type` + a fresh
 * `timestamp`.
 */
export const defineEvents = <Definition extends Record<string, Record<string, unknown>>>(
  definition: Definition,
): EventsDefinition<Definition> => {
  const namespaces: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [namespace, events] of Object.entries(definition)) {
    if (namespace.length === 0 || namespace.includes('.') || namespace === '_types') {
      throw new TypeError(
        'Event namespaces must be non-empty, contain no dots, and not use _types.',
      );
    }
    const factories: Record<string, unknown> = Object.create(null);
    for (const name of Object.keys(events)) {
      if (name.length === 0 || name.includes('.'))
        throw new TypeError('Event names must be non-empty and contain no dots.');
      const type = `${namespace}.${name}`;
      const factory = (value: unknown): InputEvent => ({
        type,
        payload: value,
        timestamp: Date.now(),
      });
      factories[name] = Object.assign(factory, { type });
    }
    namespaces[namespace] = factories;
  }
  return Object.assign(namespaces, { _types: {} }) as EventsDefinition<Definition>;
};
