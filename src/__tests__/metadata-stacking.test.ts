import { describe, it, expect, beforeEach } from 'vitest';
// Side-effect import installs the Reflect.* polyfill that funnels into MetadataRegistry.
import { MetadataRegistry, SetMetadata, Reflector } from '../index.js';

beforeEach(() => {
  MetadataRegistry.reset();
});

describe('MetadataRegistry — stacking + funnel + reset', () => {
  it('appendCustomHandlerMeta preserves append order across many calls', () => {
    class Target {}
    const handler = 'handle' as const;
    const KEY = 'stack:test';

    const inputs = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
    for (const v of inputs) {
      MetadataRegistry.appendCustomHandlerMeta(Target, handler, KEY, v);
    }

    expect(MetadataRegistry.getCustomHandlerMeta(Target, handler, KEY)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('appendCustomClassMeta is independent per (target, key)', () => {
    class A {}
    class B {}
    MetadataRegistry.appendCustomClassMeta(A, 'k', 1);
    MetadataRegistry.appendCustomClassMeta(A, 'k', 2);
    MetadataRegistry.appendCustomClassMeta(B, 'k', 99);

    expect(MetadataRegistry.getCustomClassMeta(A, 'k')).toEqual([1, 2]);
    expect(MetadataRegistry.getCustomClassMeta(B, 'k')).toEqual([99]);
  });

  it('Reflect.defineMetadata funnels into MetadataRegistry slots', () => {
    class Target {}
    Reflect.defineMetadata('vela:test:class', { v: 1 }, Target);
    Reflect.defineMetadata('vela:test:handler', { v: 2 }, Target.prototype, 'handle');

    expect(MetadataRegistry.getCustomClassMeta(Target, 'vela:test:class')).toEqual({ v: 1 });
    expect(
      MetadataRegistry.getCustomHandlerMeta(Target.prototype, 'handle', 'vela:test:handler'),
    ).toEqual({ v: 2 });

    // And the read-side polyfill returns the same value.
    expect(Reflect.getMetadata('vela:test:class', Target)).toEqual({ v: 1 });
    expect(Reflect.getMetadata('vela:test:handler', Target.prototype, 'handle')).toEqual({ v: 2 });
  });

  it('MetadataRegistry.reset() clears classMeta and handlerMeta', () => {
    class Target {}
    MetadataRegistry.setCustomClassMeta(Target, 'k', 'v');
    MetadataRegistry.setCustomHandlerMeta(Target, 'h', 'k', 'v');
    expect(MetadataRegistry.getCustomClassMeta(Target, 'k')).toBe('v');
    expect(MetadataRegistry.getCustomHandlerMeta(Target, 'h', 'k')).toBe('v');

    MetadataRegistry.reset();

    expect(MetadataRegistry.getCustomClassMeta(Target, 'k')).toBeUndefined();
    expect(MetadataRegistry.getCustomHandlerMeta(Target, 'h', 'k')).toBeUndefined();
  });

  it('class-level + handler-level @SetMetadata on the same key store independently', () => {
    const KEY = 'vela:test:scope';

    @SetMetadata(KEY, 'class-value')
    class Target {
      @SetMetadata(KEY, 'handler-value')
      handle() {}
    }

    const reflector = new Reflector();
    const ctx = {
      getClass: () => Target,
      getHandler: () => 'handle' as const,
    } as unknown as import('../index.js').ExecutionContext;

    expect(reflector.get<string>(KEY, ctx)).toBe('handler-value');
    expect(MetadataRegistry.getCustomClassMeta(Target, KEY)).toBe('class-value');
    // SetMetadata's handler form keys by the class constructor (target.constructor).
    expect(MetadataRegistry.getCustomHandlerMeta(Target, 'handle', KEY)).toBe('handler-value');
  });
});
