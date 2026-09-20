import type { Scope } from '../constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Type<T = unknown> = new (...args: any[]) => T;

// Broader: matches concrete and abstract classes. Used for metadata keying,
// where any class reference is acceptable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = unknown> = abstract new (...args: any[]) => T;

export interface InjectionTokenOptions<T> {
  readonly factory?: () => T;
}

// Runtime identity is intentionally separate from the invariant authoring token.
// Heterogeneous registries may erase T without gaining permission to rebind it.
class InjectionTokenIdentity {
  readonly options?: Readonly<InjectionTokenOptions<unknown>>;
  constructor(
    private readonly description: string,
    options?: InjectionTokenOptions<unknown>,
  ) {
    this.options = options && Object.freeze({ ...options });
  }

  toString(): string {
    return `InjectionToken(${this.description})`;
  }
}

export class InjectionToken<T = unknown> extends InjectionTokenIdentity {
  // Protected preserves this invariant function type in emitted declarations;
  // TypeScript erases the type of private fields in .d.ts output.
  declare protected readonly valueType: (value: T) => T;
  declare readonly options?: InjectionTokenOptions<T>;

  constructor(description: string, options?: InjectionTokenOptions<T>) {
    super(description, options);
    Object.freeze(this);
  }
}

export class ForwardRef<K extends Token = Token> {
  constructor(public readonly factory: () => K) {}
}

export function forwardRef<K extends Token>(factory: () => K): ForwardRef<K> {
  return new ForwardRef(factory);
}

export type TypedToken<T> = Type<T> | InjectionToken<T>;
export type Token = Type | InjectionTokenIdentity | string | symbol;

export type DependencyToken = Token | ForwardRef;

/**
 * Maps a DI token to its resolved value type at the type level:
 * - `InjectionToken<T>`           → `T`
 * - `Type<T>` / `Constructor<T>`  → `T` (the instance type)
 * - `ForwardRef<K>`               → `InferToken<K>`
 * - `string` / `symbol`           → `unknown` (runtime-only tokens carry no
 *                                   static type info).
 *
 * Used by `AsyncModuleOptions` to give `useFactory` parameters their real
 * types based on the literal `inject` tuple — without `as const` at the call
 * site (relies on the `const` type parameter on the consuming generic).
 */
export type InferToken<T> =
  T extends InjectionToken<infer U>
    ? U
    : T extends ForwardRef<infer U>
      ? InferToken<U>
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        T extends abstract new (...args: any[]) => infer U
        ? U
        : unknown;

/**
 * Map every position of a `Token[]` tuple to its resolved value type.
 * Pairs with `const Inject extends readonly Token[]` generics to
 * give `useFactory(...deps)` parameter types inferred from the literal
 * `inject` array.
 */
export type InferTokens<T extends readonly unknown[]> = {
  [K in keyof T]: InferToken<T[K]>;
};

export interface InjectableOptions {
  scope?: Scope;
}

export interface InjectMetadata {
  index: number;
  token?: Token | ForwardRef;
  optional?: boolean;
}

export interface ProviderOptions<T = unknown> {
  provide?: Token;
  scope?: Scope;
  useValue?: NoInfer<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => NoInfer<T> | Promise<NoInfer<T>>;
  useClass?: Type<NoInfer<T>>;
  // Accepts both mutable and readonly token arrays — the latter is what
  // const-tuple-inferred `AsyncModuleOptions.inject` produces when threaded
  // through to module-internal provider registrations. Behavior is identical
  // at runtime; the container iterates and resolves.
  inject?: readonly DependencyToken[];
  useExisting?: Token;
}

// The implementation class is deliberately not exported. Private state makes
// descriptors nominal: spreading one into a different object loses its proof.
class CheckedProvider<T> {
  readonly #options: Readonly<ProviderOptions<T>>;

  constructor(
    readonly provide: Token,
    options: ProviderOptions<T>,
  ) {
    this.#options = Object.freeze({
      ...options,
      provide,
      inject: options.inject && Object.freeze([...options.inject]),
    });
    Object.freeze(this);
  }

  get scope(): Scope | undefined {
    return this.#options.scope;
  }
  get useValue(): T | undefined {
    return this.#options.useValue;
  }
  get useClass(): Type<T> | undefined {
    return this.#options.useClass;
  }
  get useExisting(): Token | undefined {
    return this.#options.useExisting;
  }
  get inject(): readonly DependencyToken[] | undefined {
    return this.#options.inject;
  }
  // Reflection can inspect identity but cannot call an erased factory through
  // the public descriptor without recovering its actual dependency contract.
  get useFactory(): unknown {
    return this.#options.useFactory;
  }

  static read<T>(provider: CheckedProvider<T>): Readonly<ProviderOptions<T>> {
    return provider.#options;
  }
}

/** A nominal provider checked by defineProvider before entering a module graph. */
export type ProviderDefinition<T = unknown> = CheckedProvider<T>;

/** @internal Only the container and module loader consume erased runtime options. */
export function getProviderOptions<T>(
  provider: ProviderDefinition<T>,
): Readonly<ProviderOptions<T>> {
  return CheckedProvider.read(provider);
}

type ProviderStrategy<T, Inject extends readonly DependencyToken[]> =
  | {
      useValue: NoInfer<T>;
      useClass?: never;
      useFactory?: never;
      useExisting?: never;
      inject?: never;
    }
  | {
      useClass: Type<NoInfer<T>>;
      useValue?: never;
      useFactory?: never;
      useExisting?: never;
      inject?: never;
    }
  | {
      useExisting: Type<NoInfer<T>> | InjectionToken<NoInfer<T>>;
      useValue?: never;
      useClass?: never;
      useFactory?: never;
      inject?: never;
    }
  | {
      useFactory: (...dependencies: InferTokens<Inject>) => NoInfer<T> | Promise<NoInfer<T>>;
      inject: Inject;
      useValue?: never;
      useClass?: never;
      useExisting?: never;
    };

/** Infer factory dependencies from tokens; all strategies must produce the provided token's value. */
/** @internal Erasing an invariant token removes the capability to bind a value. */
export type AuthoringToken<K extends Token> = K extends InjectionTokenIdentity
  ? InjectionToken<InferToken<K>>
  : K;

export function defineProvider<
  const K extends Token,
  const Inject extends readonly DependencyToken[] = readonly [],
>(
  provide: K & AuthoringToken<K>,
  options: ProviderStrategy<InferToken<K>, Inject> & { scope?: Scope },
): ProviderDefinition<InferToken<K>> {
  return new CheckedProvider(provide, options);
}

export interface ProviderRegistration<T = unknown> {
  provide: Token;
  /** The declared scope (from `@Injectable`/`@Controller`/provider options). */
  scope: Scope;
  /**
   * Scope after request-scope bubbling: `REQUEST` if this provider (transitively)
   * depends on a request-scoped provider, else the declared scope. Computed once
   * at bootstrap (`Container.computeEffectiveScopes`); falls back to `scope`
   * until then. Governs caching + eager instantiation.
   */
  effectiveScope?: Scope;
  /**
   * Module that owns this registration. Used by `resolveClass` to determine
   * the POV from which the class's dependencies resolve. Sandbox/bootstrap
   * registrations land in the `"__root__"` bucket.
   */
  declaringModuleId: string;
  instance?: { readonly value: T };
  /** The cell distinguishes a declared undefined value from no value provider. */
  value?: { readonly value: T };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => T | Promise<T>;
  useClass?: Type<T>;
  inject?: readonly DependencyToken[];
  useExisting?: Token;
}

// Module visibility
export interface ModuleScope {
  moduleId: string;
  localProviders: Set<Token>;
  importedModules: Set<string>;
  exportedTokens: Set<Token>;
  isGlobal: boolean;
  /** Module instance opted into deferred (first-use) materialization. */
  lazy?: boolean;
}

/**
 * The container's seam into lazy-module materialization (implemented by
 * `LazyModuleManager`). The container only ever *claims* a pending module at
 * a resolution trigger and *drains* completed claims when the resolution
 * stack has fully unwound — construction and hook replay live behind this
 * interface so the container stays module-system-agnostic.
 */
export interface LazyResolutionHook {
  /** Is this module instance still deferred (untriggered)? */
  isPending(moduleId: string): boolean;
  /** Mark a pending module as triggered; idempotent. */
  claim(moduleId: string): void;
  /** Any claimed-but-unmaterialized groups? (cheap fast-path check) */
  hasClaimed(): boolean;
  /**
   * A drain loop is currently running. The container must NOT start (or
   * await) another drain from inside it — the running loop picks pending
   * claims up; awaiting would self-deadlock on the async path.
   */
  isDraining(): boolean;
  /** Complete claimed groups synchronously; throws if async work surfaces. */
  drainSync(): void;
  /** Complete claimed groups, awaiting async construction and hooks. */
  drainAsync(): Promise<void>;
}

export type Diagnostics = 'silent' | 'log' | 'throw';

export interface ContainerOptions {
  diagnostics?: Diagnostics;
}

/**
 * Human-readable token label — class name, `InjectionToken(desc)`, symbol
 * string, or String() fallback. Public so introspection tooling (module
 * graphs, entrypoint listings) renders tokens the same way vela's own errors
 * do.
 */
export function describeToken(token: Token): string {
  if (token instanceof InjectionToken) return token.toString();
  if (typeof token === 'function') return token.name;
  if (typeof token === 'symbol') return token.toString();
  return String(token);
}

/**
 * One module instance in the loaded graph, serializable (strings only) —
 * what `Container.getModuleDescriptions()` returns for introspection tooling
 * (`vela module graph`). Reads registration state only; never constructs.
 */
export interface ModuleDescription {
  moduleId: string;
  /** moduleIds this instance imports. */
  imports: string[];
  isGlobal: boolean;
  lazy: boolean;
  /** Token labels registered in this instance's bucket (registration order). */
  providers: string[];
  /** Token labels this instance exports. */
  exports: string[];
}

export class ModuleVisibilityError extends Error {
  constructor(
    public readonly moduleId: string,
    public readonly token: Token,
  ) {
    super(
      `Module '${moduleId}' cannot resolve '${describeToken(token)}': ` +
        `not declared in providers, not imported from another module's exports, not @Global. ` +
        `Either add to imports/exports or mark as @Global.`,
    );
    this.name = 'ModuleVisibilityError';
  }
}

export class MultipleProvidersFoundError extends Error {
  constructor(
    public readonly moduleId: string,
    public readonly token: Token,
    public readonly candidates: string[],
  ) {
    super(
      `Multiple providers found for '${describeToken(token)}' in module '${moduleId}':\n` +
        candidates.map((c) => `  - ${c}`).join('\n') +
        `\nResolve ambiguity by importing only one instance, or by using a per-instance ` +
        `accessor exposed by the module (e.g., Module.tokenFor(key)).`,
    );
    this.name = 'MultipleProvidersFoundError';
  }
}

export const ROOT_MODULE_ID = '__root__';
