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
  inject?: Token[];
  useExisting?: Token<T>;
}

export interface ProviderRegistration<T = unknown> {
  provide: Token<T>;
  scope: Scope;
  instance?: T;
  useValue?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => T | Promise<T>;
  useClass?: Type<T>;
  inject?: Token[];
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
