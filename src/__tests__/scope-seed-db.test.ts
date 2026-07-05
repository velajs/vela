import { describe, it, expect, beforeEach } from 'vitest';
import {
  Injectable,
  Inject,
  Module,
  Scope,
  REQUEST_CONTEXT,
  MetadataRegistry,
  type RequestContext,
} from '@velajs/vela';
import { Seeder, SeederModule, type ISeeder } from '@velajs/vela/seeder';
import { Test } from '../test.js';
import type { TestDatabase } from '../db/test-database.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

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

  it('root get() cannot resolve a REQUEST-scoped REQUEST_CONTEXT injector', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    expect(() => module.get(RequestScopedProbe)).toThrow();
  });

  it('returns the callback value', async () => {
    const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const result = await module.runInRequestScope(async () => 42);
    expect(result).toBe(42);
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
      user: [{ id: 1, email: 'a@b.com' }, { id: 2, email: 'c@d.com' }],
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
