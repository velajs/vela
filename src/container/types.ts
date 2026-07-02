import type { Scope } from '../constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Type<T = any> = new (...args: any[]) => T;

// Broader: matches concrete and abstract classes. Used for metadata keying,
// where any class reference is acceptable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = unknown> = abstract new (...args: any[]) => T;

export interface InjectionTokenOptions<T> {
  factory?: () => T;
}

export class InjectionToken<T = unknown> {
  constructor(
    private readonly description: string,
    public readonly options?: InjectionTokenOptions<T>,
  ) {}

  toString(): string {
    return `InjectionToken(${this.description})`;
  }
}

export class ForwardRef<T = unknown> {
  constructor(public readonly factory: () => Token<T>) {}
}

export function forwardRef<T>(factory: () => Token<T>): ForwardRef<T> {
  return new ForwardRef(factory);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Token<T = any> = Type<T> | InjectionToken<T> | string | symbol;

/**
 * Maps a single DI `Token<T>` to its resolved value type at the type level:
 * - `InjectionToken<T>`           → `T`
 * - `Type<T>` / `Constructor<T>`  → `T` (the instance type)
 * - `ForwardRef<T>`               → `T`
 * - `string` / `symbol`           → `unknown` (runtime-only tokens carry no
 *                                   static type info; the consumer asserts).
 *
 * Used by `AsyncModuleOptions` to give `useFactory` parameters their real
 * types based on the literal `inject` tuple — without `as const` at the call
 * site (relies on the `const` type parameter on the consuming generic).
 */
export type InferToken<T> =
  T extends InjectionToken<infer U> ? U :
  T extends ForwardRef<infer U> ? U :
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends abstract new (...args: any[]) => infer U ? U :
  unknown;

/**
 * Map every position of a `Token[]` tuple to its resolved value type.
 * Pairs with `const Inject extends readonly Token<unknown>[]` generics to
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
  provide?: Token<T>;
  scope?: Scope;
  useValue?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => T | Promise<T>;
  useClass?: Type<T>;
  // Accepts both mutable and readonly token arrays — the latter is what
  // const-tuple-inferred `AsyncModuleOptions.inject` produces when threaded
  // through to module-internal provider registrations. Behavior is identical
  // at runtime; the container iterates and resolves.
  inject?: readonly Token[];
  useExisting?: Token<T>;
}

export interface ProviderRegistration<T = unknown> {
  provide: Token<T>;
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
  instance?: T;
  useValue?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => T | Promise<T>;
  useClass?: Type<T>;
  inject?: readonly Token[];
  useExisting?: Token<T>;
}

// Module visibility
export interface ModuleScope {
  moduleId: string;
  localProviders: Set<Token>;
  importedModules: Set<string>;
  exportedTokens: Set<Token>;
  isGlobal: boolean;
}

export type Diagnostics = 'silent' | 'log' | 'throw';

export interface ContainerOptions {
  diagnostics?: Diagnostics;
}

function describeToken(token: Token): string {
  if (token instanceof InjectionToken) return token.toString();
  if (typeof token === 'function') return token.name;
  if (typeof token === 'symbol') return token.toString();
  return String(token);
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
