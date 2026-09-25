import type { Container } from './container/container';
import { ENV, type VelaEnv } from './env';

/**
 * Names one platform binding of the application's {@link ENV}, such as
 * `{ binding: 'CACHE' }`. Module options hold the name, never the binding: it
 * is resolved from each application's own ENV when first used, so one static
 * module graph serves every environment.
 */
export interface BindingRef {
  readonly binding: string;
}

/** How to recognize one kind of binding, and where a runtime declares it. */
export interface BindingKind<T> {
  /** What the binding is, as error messages name it: `'KV namespace'`. */
  readonly name: string;
  /** The runtime configuration key that declares it: `'kv_namespaces'`. */
  readonly configKey: string;
  /** Whether an ENV value has the operations its readers use. */
  readonly accepts: (value: unknown) => value is T;
}

/** A value an application builds from its own {@link ENV}. */
export type EnvFactory<T> = (env: VelaEnv) => T;

/**
 * A reference to one binding of a known kind. Call it with an application's
 * ENV to read and validate the native binding; it never reads an environment
 * on its own.
 */
export interface Binding<T> extends BindingRef {
  (env: VelaEnv): T;
  readonly kind: BindingKind<T>;
}

// Binding names are declared identifiers in the runtime configuration.
const BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function assertBindingRef<T>(ref: unknown, kind: BindingKind<T>): asserts ref is BindingRef {
  const name: unknown =
    typeof ref === 'object' && ref !== null ? Reflect.get(ref, 'binding') : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(
      `A ${kind.name} reference needs a non-empty { binding } name, such as { binding: 'MY_BINDING' }.`,
    );
  }
  if (!BINDING_NAME.test(name)) {
    throw new TypeError(
      `'${name}' is not a binding name: use the identifier declared under ${kind.configKey}.`,
    );
  }
}

/**
 * Read one binding from an application's ENV and check that it is the kind
 * the caller uses. The error names the binding and the configuration key that
 * declares it.
 */
export function resolveBinding<T>(
  env: VelaEnv | undefined,
  ref: BindingRef,
  kind: BindingKind<T>,
): T {
  assertBindingRef(ref, kind);
  const { binding } = ref;
  if (typeof env !== 'object' || env === null) {
    throw new Error(
      `The ${kind.name} binding '${binding}' needs the application ENV. Build the application ` +
        'with a runtime adapter that seeds it, or pass { env } to VelaFactory.create.',
    );
  }
  const value: unknown = Reflect.get(env, binding);
  if (value === undefined || value === null) {
    throw new Error(
      `ENV.${binding} is not set: declare the ${kind.name} binding '${binding}' under ` +
        `${kind.configKey} in the runtime configuration.`,
    );
  }
  if (!kind.accepts(value)) {
    throw new TypeError(
      `ENV.${binding} is not a binding of type ${kind.name}: declare '${binding}' under ` +
        `${kind.configKey} in the runtime configuration.`,
    );
  }
  return value;
}

/**
 * Define a lower-camel binding factory for one kind:
 *
 * ```ts
 * export const kv = defineBinding<KVNamespace>({ name: 'KV namespace', configKey: 'kv_namespaces', accepts });
 * const cache = kv({ binding: 'CACHE' }); // validated now, resolved per ENV later
 * ```
 */
export function defineBinding<T>(kind: BindingKind<T>): (ref: BindingRef) => Binding<T> {
  return (ref) => {
    assertBindingRef(ref, kind);
    const { binding } = ref;
    const resolve = (env: VelaEnv): T => resolveBinding(env, { binding }, kind);
    return Object.freeze(Object.assign(resolve, { binding, kind }));
  };
}

const EMPTY_ENV: VelaEnv = Object.freeze({});

/**
 * The ENV of the application a container belongs to, or an empty environment
 * when no runtime seeded one, so a binding read fails with the binding's own
 * message. Use it in module providers that build values from
 * {@link EnvFactory} options.
 */
export function readEnv(container: Container): VelaEnv {
  return container.has(ENV) ? container.resolve(ENV) : EMPTY_ENV;
}
