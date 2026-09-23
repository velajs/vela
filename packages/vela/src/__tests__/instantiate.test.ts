import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from '../container/container.js';
import { Inject, Injectable } from '../container/decorators.js';
import { instantiate } from '../http/instantiate.js';
import { Reflector } from '../pipeline/reflector.js';

// Direct unit tests for the http/instantiate helper, which materializes
// guards/pipes/interceptors/filters/middleware per request. Regression target:
// the helper used to fall back to a bare `new clazz()` when the container had
// no registration for the class — that silently bypassed the DI graph,
// constructing the class with every `@Inject(...)` field set to `undefined`.
// The historical downstream symptom was `AuthGuard.canActivate` crashing with
// "Cannot read properties of undefined (reading 'getAllAndOverride')" because
// the injected `Reflector` was never supplied.
describe('instantiate()', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  it('resolves through the container when the class is registered', () => {
    @Injectable()
    class Service {
      readonly tag = 'real';
    }
    container.register(Service);

    const resolved = instantiate<Service>(Service, container);
    expect(resolved).toBeInstanceOf(Service);
    expect(resolved.tag).toBe('real');
    // Same instance on a second call — confirms it came from the container's
    // singleton cache, not from a fresh `new` call.
    expect(instantiate<Service>(Service, container)).toBe(resolved);
  });

  it('falls back to `new` for plain helper classes with no DI surface', () => {
    // No @Injectable(), no @Inject() — the safe historical fallback path.
    class PlainHelper {
      readonly tag = 'plain';
    }

    const resolved = instantiate<PlainHelper>(PlainHelper, container);
    expect(resolved).toBeInstanceOf(PlainHelper);
    expect(resolved.tag).toBe('plain');
  });

  it('falls back to `new` for parameterless @Injectable() classes (mixin path)', () => {
    // `mixin()` and many ad-hoc `@UseGuards(LocalGuard)` references slap
    // @Injectable() onto a parameterless class without registering it as a
    // provider. That stays safe — there are no injected slots to leave
    // `undefined`. Regression-protect the mixin path.
    @Injectable()
    class ParameterlessGuard {
      readonly tag = 'mixin';
    }

    const resolved = instantiate<ParameterlessGuard>(ParameterlessGuard, container);
    expect(resolved).toBeInstanceOf(ParameterlessGuard);
    expect(resolved.tag).toBe('mixin');
  });

  it('passes through pre-built instances untouched', () => {
    class Anything {
      readonly tag = 'instance';
    }
    const inst = new Anything();
    expect(instantiate<Anything>(inst, container)).toBe(inst);
  });

  // Regression: see file-level comment. An @Injectable class that depends on
  // another provider via @Inject(...) MUST NOT be constructed via `new` —
  // doing so leaves `this.reflector` (or any other injected field)
  // `undefined`. The fix surfaces this as a loud error at the resolution
  // site instead of letting a half-built guard reach `canActivate`.
  it('throws (not silent `new`) for an @Injectable() class missing from the container', () => {
    @Injectable()
    class AuthGuard {
      constructor(@Inject(Reflector) public readonly reflector: Reflector) {}
    }

    expect(() => instantiate<AuthGuard>(AuthGuard, container)).toThrowError(
      /Cannot instantiate AuthGuard.*declares constructor dependencies/s,
    );
  });

  it('throws for a class with @Inject() params even if @Injectable() is absent', () => {
    // Some downstream code-style configs omit @Injectable() but still use
    // @Inject() at the constructor. The fallback must still refuse.
    class ManualGuard {
      constructor(@Inject(Reflector) public readonly reflector: Reflector) {}
    }

    expect(() => instantiate<ManualGuard>(ManualGuard, container)).toThrowError(
      /Cannot instantiate ManualGuard.*declares constructor dependencies/s,
    );
  });

  // The full downstream repro: AuthGuard reaches `instantiate()` as a bare
  // class ref, the container has no registration for it (the user wired the
  // guard only via `useExisting` / `useGlobalGuards` without also registering
  // it as a normal provider), and the helper used to return a Reflector-less
  // instance whose `canActivate()` crashed at first read of `this.reflector`.
  // Post-fix the helper rejects this shape outright.
  it('regression: unregistered guard with @Inject(Reflector) no longer yields a Reflector-less instance', () => {
    @Injectable()
    class AuthGuard {
      constructor(@Inject(Reflector) public readonly reflector: Reflector) {}
      canActivate(): boolean {
        // Would crash with "Cannot read properties of undefined ..." pre-fix.
        return this.reflector !== undefined;
      }
    }

    // No `container.register(AuthGuard)` — mirrors the broken downstream path.
    expect(() => instantiate<AuthGuard>(AuthGuard, container)).toThrow();
  });
});
