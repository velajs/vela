import { describe, it, expect } from 'vitest';
import { Controller, Injectable, Scope } from '../index.js';
import { MetadataRegistry } from '../module-kit.js';
import { WebSocketGateway } from '../websocket/index.js';
import { getScope } from '../container/decorators';
import { Seeder } from '../seeder';

describe('class decorator scope declarations', () => {
  it('names the default lifetime Scope.DEFAULT without a SINGLETON alias', () => {
    expect(Scope).toEqual({ DEFAULT: 'default', TRANSIENT: 'transient', REQUEST: 'request' });
    // @ts-expect-error The singleton lifetime was renamed to Scope.DEFAULT.
    expect(Scope['SINGLETON']).toBeUndefined();
  });

  it('writes no scope unless one is passed; reads default to Scope.DEFAULT', () => {
    @Injectable()
    class Plain {}

    @Controller('/plain')
    class PlainController {}

    @WebSocketGateway({ path: '/plain' })
    class PlainGateway {}

    @Seeder()
    class PlainSeeder {}

    for (const target of [Plain, PlainController, PlainGateway, PlainSeeder]) {
      expect(MetadataRegistry.getScope(target)).toBeUndefined();
      expect(getScope(target)).toBe(Scope.DEFAULT);
    }
  });

  it('keeps an @Injectable scope whichever side of @Controller it sits on', () => {
    @Injectable({ scope: Scope.REQUEST })
    @Controller('/above')
    class InjectableAbove {}

    @Controller('/below')
    @Injectable({ scope: Scope.REQUEST })
    class InjectableBelow {}

    expect(getScope(InjectableAbove)).toBe(Scope.REQUEST);
    expect(getScope(InjectableBelow)).toBe(Scope.REQUEST);
  });

  it('keeps an @Injectable scope whichever side of @WebSocketGateway or @Seeder it sits on', () => {
    @Injectable({ scope: Scope.REQUEST })
    @WebSocketGateway({ path: '/above' })
    class GatewayAbove {}

    @WebSocketGateway({ path: '/below' })
    @Injectable({ scope: Scope.REQUEST })
    class GatewayBelow {}

    @Injectable({ scope: Scope.REQUEST })
    @Seeder()
    class SeederAbove {}

    @Seeder()
    @Injectable({ scope: Scope.REQUEST })
    class SeederBelow {}

    for (const target of [GatewayAbove, GatewayBelow, SeederAbove, SeederBelow]) {
      expect(getScope(target)).toBe(Scope.REQUEST);
    }
  });

  it('accepts a scope on @Controller options', () => {
    @Controller({ path: '/scoped', scope: Scope.REQUEST })
    class ScopedController {}

    @Controller({ path: '/transient', version: 1, scope: Scope.TRANSIENT })
    class TransientController {}

    expect(MetadataRegistry.getControllerPath(ScopedController)).toBe('/scoped');
    expect(getScope(ScopedController)).toBe(Scope.REQUEST);
    expect(getScope(TransientController)).toBe(Scope.TRANSIENT);
  });

  it('allows the same explicit scope to be declared twice', () => {
    @Controller({ path: '/twice', scope: Scope.REQUEST })
    @Injectable({ scope: Scope.REQUEST })
    class DeclaredTwice {}

    expect(getScope(DeclaredTwice)).toBe(Scope.REQUEST);
  });

  it('throws when one class declares two different scopes', () => {
    expect(() => {
      @Controller({ path: '/conflict', scope: Scope.REQUEST })
      @Injectable({ scope: Scope.TRANSIENT })
      class ControllerConflict {}
      return ControllerConflict;
    }).toThrow(
      'ControllerConflict declares conflicting scopes "transient" and "request"; declare its scope once.',
    );

    expect(() => {
      @Injectable({ scope: Scope.DEFAULT })
      @Injectable({ scope: Scope.REQUEST })
      class InjectableConflict {}
      return InjectableConflict;
    }).toThrow(/InjectableConflict declares conflicting scopes "request" and "default"/);
  });
});
