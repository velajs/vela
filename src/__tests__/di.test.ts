import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'bun:test';
import { Container } from '../container/container.js';
import { Injectable, Inject } from '../container/decorators.js';
import { InjectionToken } from '../container/types.js';
import { Scope } from '../constants.js';

describe('DI Container', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  describe('transient scope', () => {
    it('should create a new instance every time for transient providers', () => {
      @Injectable({ scope: Scope.TRANSIENT })
      class TransientService {
        id = Math.random();
      }

      container.register(TransientService);

      const a = container.resolve(TransientService);
      const b = container.resolve(TransientService);

      expect(a).not.toBe(b);
      expect(a.id).not.toBe(b.id);
    });

    it('should return the same instance for singleton (default)', () => {
      @Injectable()
      class SingletonService {
        id = Math.random();
      }

      container.register(SingletonService);

      const a = container.resolve(SingletonService);
      const b = container.resolve(SingletonService);

      expect(a).toBe(b);
      expect(a.id).toBe(b.id);
    });
  });

  describe('circular dependency detection', () => {
    it('should throw on direct circular dependency (A → B → A)', () => {
      // Use InjectionTokens + factories to create a clear circular chain
      const TOKEN_A = new InjectionToken('A');
      const TOKEN_B = new InjectionToken('B');

      container.register({
        token: TOKEN_A,
        useFactory: (b: unknown) => ({ name: 'A', dep: b }),
        inject: [TOKEN_B],
      });

      container.register({
        token: TOKEN_B,
        useFactory: (a: unknown) => ({ name: 'B', dep: a }),
        inject: [TOKEN_A],
      });

      expect(() => container.resolve(TOKEN_A)).toThrow(/Circular dependency detected/);
    });

    it('should throw on indirect circular dependency (A → B → C → A)', () => {
      const TOKEN_A = new InjectionToken('A');
      const TOKEN_B = new InjectionToken('B');
      const TOKEN_C = new InjectionToken('C');

      container.register({
        token: TOKEN_A,
        useFactory: (b: unknown) => ({ name: 'A', dep: b }),
        inject: [TOKEN_B],
      });

      container.register({
        token: TOKEN_B,
        useFactory: (c: unknown) => ({ name: 'B', dep: c }),
        inject: [TOKEN_C],
      });

      container.register({
        token: TOKEN_C,
        useFactory: (a: unknown) => ({ name: 'C', dep: a }),
        inject: [TOKEN_A],
      });

      expect(() => container.resolve(TOKEN_A)).toThrow(/Circular dependency detected/);
    });
  });

  describe('factory providers', () => {
    it('should create instance via factory function', () => {
      const CONFIG = new InjectionToken<{ port: number }>('CONFIG');

      container.register({
        token: CONFIG,
        useFactory: () => ({ port: 3000 }),
      });

      const config = container.resolve(CONFIG);
      expect(config).toEqual({ port: 3000 });
    });

    it('should inject dependencies into factory', () => {
      const DB_URL = new InjectionToken<string>('DB_URL');
      const DB = new InjectionToken<{ url: string; connected: boolean }>('DB');

      container.register({
        token: DB_URL,
        useValue: 'postgres://localhost/mydb',
      });

      container.register({
        token: DB,
        useFactory: (url: string) => ({ url, connected: true }),
        inject: [DB_URL],
      });

      const db = container.resolve(DB);
      expect(db).toEqual({ url: 'postgres://localhost/mydb', connected: true });
    });

    it('should cache singleton factory result', () => {
      let callCount = 0;
      const COUNTER = new InjectionToken<number>('COUNTER');

      container.register({
        token: COUNTER,
        useFactory: () => ++callCount,
      });

      const a = container.resolve(COUNTER);
      const b = container.resolve(COUNTER);

      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(callCount).toBe(1);
    });

    it('should not cache transient factory result', () => {
      let callCount = 0;
      const COUNTER = new InjectionToken<number>('COUNTER');

      container.register({
        token: COUNTER,
        scope: Scope.TRANSIENT,
        useFactory: () => ++callCount,
      });

      const a = container.resolve(COUNTER);
      const b = container.resolve(COUNTER);

      expect(a).toBe(1);
      expect(b).toBe(2);
    });
  });

  describe('resolveAsync', () => {
    it('should resolve async factory providers', async () => {
      const ASYNC_DATA = new InjectionToken<string>('ASYNC_DATA');

      container.register({
        token: ASYNC_DATA,
        useFactory: async () => {
          // Simulate async operation
          return 'loaded';
        },
      });

      const data = await container.resolveAsync(ASYNC_DATA);
      expect(data).toBe('loaded');
    });

    it('should cache async singleton result', async () => {
      let callCount = 0;
      const ASYNC_COUNTER = new InjectionToken<number>('ASYNC_COUNTER');

      container.register({
        token: ASYNC_COUNTER,
        useFactory: async () => ++callCount,
      });

      const a = await container.resolveAsync(ASYNC_COUNTER);
      const b = await container.resolveAsync(ASYNC_COUNTER);

      expect(a).toBe(1);
      expect(b).toBe(1);
    });
  });

  describe('useValue and useExisting', () => {
    it('should resolve useValue providers directly', () => {
      const TOKEN = new InjectionToken<string>('TOKEN');
      container.register({ token: TOKEN, useValue: 'hello' });
      expect(container.resolve(TOKEN)).toBe('hello');
    });

    it('should resolve useExisting as alias', () => {
      @Injectable()
      class RealService {
        name = 'real';
      }

      const ALIAS = new InjectionToken<RealService>('ALIAS');

      container.register(RealService);
      container.register({ token: ALIAS, useExisting: RealService });

      const fromAlias = container.resolve(ALIAS);
      const fromReal = container.resolve(RealService);

      expect(fromAlias).toBe(fromReal);
      expect(fromAlias.name).toBe('real');
    });
  });

  describe('InjectionToken with default factory', () => {
    it('should use default factory when no provider is registered', () => {
      const TOKEN = new InjectionToken<{ env: string }>('TOKEN', {
        factory: () => ({ env: 'development' }),
      });

      const value = container.resolve(TOKEN);
      expect(value).toEqual({ env: 'development' });
    });
  });

  describe('error cases', () => {
    it('should throw for unregistered token without default', () => {
      const TOKEN = new InjectionToken('MISSING');
      expect(() => container.resolve(TOKEN)).toThrow(/No provider found/);
    });

    it('should throw for sync resolve of async factory', () => {
      const TOKEN = new InjectionToken('ASYNC');
      container.register({
        token: TOKEN,
        useFactory: async () => 'data',
      });

      expect(() => container.resolve(TOKEN)).toThrow(/returned a Promise/);
    });
  });

  describe('request scope', () => {
    it('should create separate instances per child container', () => {
      @Injectable({ scope: Scope.REQUEST })
      class RequestService {
        id = Math.random();
      }

      container.register(RequestService);

      const child1 = container.createChild();
      const child2 = container.createChild();

      const a = child1.resolve(RequestService);
      const b = child1.resolve(RequestService); // same child — same instance
      const c = child2.resolve(RequestService); // different child — different instance

      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('should share singletons across child containers', () => {
      @Injectable()
      class SingletonService {
        id = Math.random();
      }

      container.register(SingletonService);

      const child1 = container.createChild();
      const child2 = container.createChild();

      const a = child1.resolve(SingletonService);
      const b = child2.resolve(SingletonService);

      expect(a).toBe(b);
    });
  });
});
