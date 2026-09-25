import { describe, expect, it, vi } from 'vitest';
import { Context } from 'hono';
import { Inject, Injectable, InjectionToken, Scope, defineProvider } from '@velajs/vela';
import { Container, DiscoveryService } from '@velajs/vela/module-kit';
import { AdminRpc, AdminConfirmSummary } from '../src/rpc/admin-rpc.decorator';
import { StudioDispatchRegistry } from '../src/rpc/dispatch.registry';
import { ConfirmTokenSigner } from '../src/security/confirm-token';
import { AdminAuditLog } from '../src/audit/audit-log';
import { STUDIO_TEST_ONLY_OPS } from '../src/tokens';
import type { AdminOpContext } from '../src/studio.types';

function registry(container: Container): StudioDispatchRegistry {
  container.register(defineProvider(STUDIO_TEST_ONLY_OPS, { useValue: ['test.scoped'] }));
  for (const moduleId of new Set(
    container.getTokens().flatMap((token) => container.getOwnerModuleIds(token)),
  )) {
    container.registerScope({
      moduleId,
      localProviders: new Set(
        container.getTokens().filter((token) => container.hasInScope(token, moduleId)),
      ),
      importedModules: new Set(),
      exportedTokens: new Set(),
      global: false,
    });
  }
  const result = new StudioDispatchRegistry(
    container,
    new DiscoveryService(container),
    new ConfirmTokenSigner('test-token'),
    new AdminAuditLog(20),
  );
  result.onApplicationBootstrap();
  return result;
}
function context(container: Container): AdminOpContext {
  return {
    http: new Context(new Request('https://studio.test/_vela/admin/rpc/test.scoped')),
    admin: { subject: 'master', via: 'master-token', ip: null },
    editable: {
      data: false,
      schema: false,
      identity: false,
      ops: false,
      timeTravel: false,
      transfer: false,
    },
    audit: () => {},
    get: (token) => container.resolve(token),
  };
}

describe('Studio registration-aware dispatch', () => {
  it('discovers metadata without construction and awaits owned factories in fresh disposable scopes', async () => {
    const dependency = new InjectionToken<{ id: string }>('private dependency');
    const created = vi.fn();
    const destroyed: string[] = [];
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      #id: string;
      constructor(@Inject(dependency) value: { id: string }) {
        this.#id = value.id;
        created();
      }
      @AdminRpc({ op: 'test.scoped' })
      async run(ctx: AdminOpContext) {
        return { id: this.#id, same: ctx.get(dependency).id === this.#id };
      }
      [Symbol.dispose]() {
        destroyed.push(this.#id);
      }
    }
    const container = new Container();
    container.register(defineProvider(dependency, { useValue: { id: 'wrong-owner' } }), 'other');
    container.register(
      defineProvider(dependency, {
        scope: Scope.REQUEST,
        useFactory: async () => ({ id: crypto.randomUUID() }),
      }),
      'handler',
    );
    container.register(Handler, 'handler');
    const dispatch = registry(container);
    expect(created).not.toHaveBeenCalled();
    const results = await Promise.all(
      [1, 2].map(() => dispatch.dispatch('test.scoped', {}, context(container))),
    );
    expect(results).toEqual([
      expect.objectContaining({ ok: true, data: { id: expect.any(String), same: true } }),
      expect.objectContaining({ ok: true, data: { id: expect.any(String), same: true } }),
    ]);
    expect(new Set(destroyed).size).toBe(2);
    expect(destroyed).not.toContain('wrong-owner');
  });

  it('preserves symbol methods and private receivers', async () => {
    const key = Symbol('operation');
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      #answer = 42;
      @AdminRpc({ op: 'test.scoped' }) [key]() {
        return this.#answer;
      }
    }
    const container = new Container();
    container.register(Handler, 'owner');
    expect(await registry(container).dispatch('test.scoped', {}, context(container))).toMatchObject(
      { ok: true, data: 42 },
    );
  });

  it('enforces closed gates before resolving handlers or summarizers', async () => {
    const constructed = vi.fn();
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      constructor() {
        constructed();
      }
      @AdminRpc({ op: 'data.clearTable' }) run() {
        return {};
      }
      @AdminConfirmSummary({ op: 'data.clearTable' }) summary() {
        return 'clear';
      }
    }
    const container = new Container();
    container.register(Handler, 'owner');
    expect(
      await registry(container).dispatch(
        'data.clearTable',
        { args: { model: 'items' } },
        context(container),
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(constructed).not.toHaveBeenCalled();
  });

  it('rejects duplicate handler owners and duplicate confirmation summaries', () => {
    @Injectable()
    class Handler {
      @AdminRpc({ op: 'test.scoped' }) run() {}
    }
    const container = new Container();
    container.register(Handler, 'one');
    container.register(Handler, 'two');
    expect(() => registry(container)).toThrow('duplicate handler');
    @Injectable()
    class Summary {
      @AdminConfirmSummary({ op: 'data.clearTable' }) run() {
        return 'clear';
      }
    }
    const other = new Container();
    other.register(Summary, 'one');
    other.register(Summary, 'two');
    expect(() => registry(other)).toThrow('duplicate summary');
  });

  it('resolves confirmation summaries in their own module and disposes their scope', async () => {
    const label = new InjectionToken<string>('summary label');
    const destroyed = vi.fn();
    @Injectable({ scope: Scope.REQUEST })
    class Summary {
      @AdminConfirmSummary({ op: 'data.clearTable' }) summary(ctx: AdminOpContext) {
        return ctx.get(label);
      }
      [Symbol.dispose]() {
        destroyed();
      }
    }
    @Injectable({ scope: Scope.REQUEST })
    class Handler {
      @AdminRpc({ op: 'data.clearTable' }) run() {
        return {};
      }
    }
    const container = new Container();
    container.register(defineProvider(label, { useValue: 'wrong' }), 'handler');
    container.register(defineProvider(label, { useValue: 'owned summary' }), 'summary');
    container.register(Handler, 'handler');
    container.register(Summary, 'summary');
    const ctx = context(container);
    ctx.editable.data = true;
    const response = await registry(container).dispatch(
      'data.clearTable',
      { args: { model: 'items' } },
      ctx,
    );
    expect(response).toMatchObject({
      ok: false,
      status: 428,
      error: { details: { summary: 'owned summary' } },
    });
    expect(destroyed).toHaveBeenCalledOnce();
  });
});
