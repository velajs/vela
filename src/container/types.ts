import type { Scope } from '../constants.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Type<T = any> = new (...args: any[]) => T;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Token<T = any> = Type<T> | InjectionToken<T> | string | symbol;

export interface InjectableOptions {
  scope?: Scope;
}

export interface InjectMetadata {
  index: number;
  token: Token;
}

export interface ProviderOptions<T = unknown> {
  token?: Token<T>;
  scope?: Scope;
  useValue?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => T | Promise<T>;
  inject?: Token[];
  useExisting?: Token<T>;
}

export interface ProviderRegistration<T = unknown> {
  token: Token<T>;
  scope: Scope;
  instance?: T;
  useValue?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => T | Promise<T>;
  useClass?: Type<T>;
  inject?: Token[];
  useExisting?: Token<T>;
}
