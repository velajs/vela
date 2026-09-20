import { describe, it, expect } from 'vitest';
import {
  InjectionToken,
  type AsyncModuleOptions,
  type InferToken,
  type InferTokens,
  type Token,
} from '../index.js';

// Compile-time type tests via tuple/equality checks. If any of these fail
// to typecheck, the regression test file itself won't compile and the
// `pnpm typecheck` step in CI catches it before this file ever runs.

// Helper: produces a TS error if `T` is not assignable from `U`.
type Assert<T extends true> = T;
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('InferToken / InferTokens', () => {
  it('maps InjectionToken<T> to T (compile-time)', () => {
    type Tok = InjectionToken<string>;
    type _ = Assert<Eq<InferToken<Tok>, string>>;

    // The token itself isn't constructed at runtime here — the assertion is
    // type-only. The runtime `it` block just exists to satisfy vitest.
    expect(true).toBe(true);
  });

  it('maps class constructors to their instance type', () => {
    class Foo {
      foo(): number {
        return 1;
      }
    }
    type _ = Assert<Eq<InferToken<typeof Foo>, Foo>>;
    expect(true).toBe(true);
  });

  it('maps mixed tuples to the corresponding instance-type tuple', () => {
    class A {
      a = 1;
    }
    class B {
      b = '';
    }
    type Tokens = readonly [typeof A, typeof B];
    type _ = Assert<Eq<InferTokens<Tokens>, readonly [A, B]>>;
    expect(true).toBe(true);
  });

  it('AsyncModuleOptions infers useFactory params from inject tuple', () => {
    class D1Service {
      database = 'db' as const;
    }
    class ConfigService {
      get(k: string): string {
        return k;
      }
    }

    // Imagine a third-party module's `forRootAsync` consumer call site —
    // type inference must give `(d1, config)` the right types WITHOUT
    // explicit annotations, WITHOUT `as const`. The function below is
    // never called at runtime; its body exists only to assert that TS
    // sees `d1: D1Service` and `config: ConfigService` (the access of
    // instance fields fails to compile if inference broke).
    function _forRootAsync<
      T,
      const Inject extends readonly Token[] = readonly Token[],
    >(opts: AsyncModuleOptions<T, Inject>): AsyncModuleOptions<T, Inject> {
      return opts;
    }

    const opts = _forRootAsync({
      inject: [D1Service, ConfigService],
      useFactory: (d1, config) => {
        const _db: 'db' = d1.database;
        const _v: string = config.get('x');
        void _db;
        void _v;
        return { ok: true };
      },
    });

    // Sanity at runtime: the factory exists and inject was captured.
    expect(opts.inject).toEqual([D1Service, ConfigService]);
    expect(typeof opts.useFactory).toBe('function');
  });

  it('falls back to unknown[] when inject is not a literal tuple', () => {
    type Opts = AsyncModuleOptions<{ ok: true }>;
    // Default Inject — `useFactory` accepts variadic unknown[] (backwards-compat).
    const opts: Opts = { inject: [],
      useFactory: (...args: unknown[]) => {
        void args;
        return { ok: true } as const;
      },
    };
    expect(opts.useFactory()).toEqual({ ok: true });
  });
});
