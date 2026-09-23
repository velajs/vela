import { describe, it, expect, beforeEach } from 'vitest';
import {
  Injectable,
  Inject,
  Module,
  Scope,
  REQUEST_CONTEXT,
  RequestContextKey,
  type RequestContext,
} from '@velajs/vela';
import { getRequestContainer } from '@velajs/vela/module-kit';
import { Seeder, SeederModule, type ISeeder } from '@velajs/vela/seeder';
import { Test } from '../test.js';
import type { TestDatabase } from '../db/test-database.js';

// ---------------------------------------------------------------------------
// runInRequestScope
// ---------------------------------------------------------------------------

@Injectable({ scope: Scope.REQUEST })
class RequestScopedProbe {
  constructor(@Inject(REQUEST_CONTEXT) readonly ctx: RequestContext) {}
  requestId(): string {
    return this.ctx.id;
  }
}

@Module({ providers: [RequestScopedProbe] })
class ProbeModule {}

describe('module.runInRequestScope', () => {
  it('resolves a REQUEST-scoped provider that injects REQUEST_CONTEXT', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

    const id = await module.runInRequestScope(async (container) => {
      const probe = container.resolve(RequestScopedProbe);
      return probe.requestId();
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('root get() refuses a REQUEST-scoped provider and points to resolveInRequest()', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    expect(() => module.get(RequestScopedProbe)).toThrow(/resolveInRequest/);
  });

  it('returns the callback value', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const result = await module.runInRequestScope(async () => 42);
    expect(result).toBe(42);
  });

  it('uses production request context storage and isolates successive scopes', async () => {
    const key = new RequestContextKey<string>('trace');
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

    await module.runInRequestScope((container) => {
      const context = container.resolve(REQUEST_CONTEXT);
      expect(context.request).toBe(context.hono.req.raw);
      expect(getRequestContainer(context.hono)).toBe(container);
      context.set(key, 'first');
      expect(context.get(key)).toBe('first');
      expect(context.has(key)).toBe(true);
    });
    await module.runInRequestScope((container) => {
      expect(container.resolve(REQUEST_CONTEXT).has(key)).toBe(false);
    });
    await module.close();
  });
});

// ---------------------------------------------------------------------------
// resolveInRequest
// ---------------------------------------------------------------------------

describe('module.resolveInRequest', () => {
  it('resolves each call in a fresh request seeded from the init', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

    const first = await module.resolveInRequest(RequestScopedProbe, {
      url: 'http://localhost/items?page=2',
      headers: { 'x-request-id': 'probe-1' },
    });
    const second = await module.resolveInRequest(RequestScopedProbe);

    expect(first).toBeInstanceOf(RequestScopedProbe);
    expect(first).not.toBe(second);
    expect(first.requestId()).toBe('probe-1');
    expect(first.ctx.request.url).toBe('http://localhost/items?page=2');
    expect(second.ctx.request.url).toBe('http://localhost/');
    expect(getRequestContainer(first.ctx.hono).resolve(RequestScopedProbe)).toBe(first);
    await module.close();
  });

  it('keeps the request open until close(), then disposes it', async () => {
    const disposed: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class Session {
      [Symbol.dispose]() {
        disposed.push('session');
      }
    }

    @Module({ providers: [Session] })
    class SessionModule {}

    const module = await Test.createTestingModule({ imports: [SessionModule] }).compile();
    const session = await module.resolveInRequest(Session);
    expect(session).toBeInstanceOf(Session);
    expect(disposed).toEqual([]);

    await module.close();
    expect(disposed).toEqual(['session']);
  });

  it('closes the request again when resolution fails', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await expect(module.resolveInRequest('missing-token')).rejects.toThrow(/No provider/);
    await module.close();
  });
});

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

const seededOrder: string[] = [];

@Seeder()
class FirstSeeder implements ISeeder {
  run(): void {
    seededOrder.push('first');
  }
}

@Seeder()
class SecondSeeder implements ISeeder {
  run(): void {
    seededOrder.push('second');
  }
}

@Seeder()
class UnregisteredSeeder implements ISeeder {
  run(): void {
    seededOrder.push('nope');
  }
}

describe('module.seed', () => {
  beforeEach(() => {
    seededOrder.length = 0;
  });

  it('runs the given seeders in call order', async () => {
    const module = await Test.createTestingModule({
      imports: [SeederModule.forRoot({ seeders: [FirstSeeder, SecondSeeder] })],
    }).compile();

    await module.seed(SecondSeeder, FirstSeeder);
    expect(seededOrder).toEqual(['second', 'first']);
  });

  it('throws when a class is not a registered seeder', async () => {
    const module = await Test.createTestingModule({
      imports: [SeederModule.forRoot({ seeders: [FirstSeeder] })],
    }).compile();

    await expect(module.seed(UnregisteredSeeder)).rejects.toThrow(/not registered/);
  });
});

// ---------------------------------------------------------------------------
// database assertion wrappers (against a TestDatabase contract stub)
// ---------------------------------------------------------------------------

class InMemoryTestDatabase implements TestDatabase {
  constructor(private rows: Record<string, Record<string, unknown>[]>) {}
  async truncate(): Promise<void> {
    for (const key of Object.keys(this.rows)) this.rows[key] = [];
  }
  async has(table: string, where: Record<string, unknown>): Promise<boolean> {
    return (this.rows[table] ?? []).some((row) =>
      Object.entries(where).every(([k, v]) => row[k] === v),
    );
  }
  async count(table: string): Promise<number> {
    return (this.rows[table] ?? []).length;
  }
}

describe('module database assertions', () => {
  it('assertDatabaseHas / Missing / Count delegate to the TestDatabase', async () => {
    const module = await Test.createTestingModule({ providers: [] }).compile();
    const db = new InMemoryTestDatabase({
      user: [
        { id: 1, email: 'a@b.com' },
        { id: 2, email: 'c@d.com' },
      ],
    });

    await module.assertDatabaseHas(db, 'user', { email: 'a@b.com' });
    await module.assertDatabaseMissing(db, 'user', { email: 'x@y.com' });
    await module.assertDatabaseCount(db, 'user', 2);
  });

  it('assertDatabaseHas throws when the row is absent', async () => {
    const module = await Test.createTestingModule({ providers: [] }).compile();
    const db = new InMemoryTestDatabase({ user: [] });
    await expect(module.assertDatabaseHas(db, 'user', { id: 9 })).rejects.toThrow();
  });
});
