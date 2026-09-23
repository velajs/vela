import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from '../container/container.js';
import { Injectable, Inject } from '../container/decorators.js';
import {
  InjectionToken,
  MissingInjectionMetadataError,
  UnresolvedDependencyError,
} from '../container/types.js';

describe('DI error hints — import type mistake', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  it('registration hints about import type when paramtype is undefined/Object', () => {
    // Simulate what TypeScript emits for a `import type { Foo }` paramtype:
    // design:paramtypes contains Object (or undefined) at that index.
    @Injectable()
    class ServiceA {
      // @ts-expect-error — we're explicitly using Object as a paramtype
      constructor(public dep: Object) {}
    }

    // Stamp paramtypes as Object so DI hits the "undefined or Object" branch.
    Reflect.defineMetadata('design:paramtypes', [Object], ServiceA);

    // The erased paramtype is rejected when the class is registered, before
    // anything could construct it with an undefined dependency.
    let caught: Error | undefined;
    try {
      container.register(ServiceA);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(MissingInjectionMetadataError);
    expect(caught!.message).toMatch(/ServiceA/);
    expect(caught!.message).toMatch(/import type/);
    expect(caught!.message).toMatch(/runtime `import/);
  });

  it('resolve() hints about import type when token itself is Object', () => {
    // Direct (degenerate) case: calling resolve(Object) should produce a
    // helpful error because Object is the fingerprint of a stripped type.
    let caught: Error | undefined;
    try {
      container.resolve(Object as unknown as InjectionToken);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/import type/);
    expect(caught!.message).toMatch(/runtime `import/);
  });

  it('regular "no provider found" error does NOT include import type hint', () => {
    const TOKEN = new InjectionToken('REAL_MISSING');
    let caught: Error | undefined;
    try {
      container.resolve(TOKEN);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/No provider found/);
    // InjectionToken mistakes aren't caused by `import type`, so no hint.
    expect(caught!.message).not.toMatch(/import type/);
  });

  it('@Inject() token case still works normally (no false-positive hint)', () => {
    const TOKEN = new InjectionToken<string>('MY_TOKEN');

    @Injectable()
    class ServiceB {
      constructor(@Inject(TOKEN) public value: string) {}
    }

    container.register(ServiceB);
    // TOKEN not registered — names ServiceB's argument, caused by "No provider
    // found", without the import-type hint.
    let caught: unknown;
    try {
      container.resolve(ServiceB);
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof UnresolvedDependencyError)) throw caught;
    expect(caught.message).toBe(
      'Cannot resolve ServiceB(?) in the root container. Argument #0 InjectionToken(MY_TOKEN) ' +
        'is not provided by any module.',
    );
    expect(caught.cause).toBeInstanceOf(Error);
    expect(String(caught.cause)).toMatch(/No provider found/);
    expect(String(caught.cause)).not.toMatch(/import type/);
  });
});
