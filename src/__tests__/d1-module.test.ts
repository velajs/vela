import { describe, it, expect, beforeEach } from 'vitest';
import {
  Controller,
  Get,
  Module,
  MetadataRegistry,
} from '@velajs/vela';
import { CloudflareFactory } from '../cloudflare-factory';
import { D1Module } from '../modules/d1.module';
import { D1Service } from '../services/d1.service';
import { clearBindingsRegistry } from '../tokens';

beforeEach(() => {
  MetadataRegistry.clear();
  clearBindingsRegistry();
});

function createMockD1() {
  const tables = new Map<string, unknown[]>();

  const createStatement = (query: string, boundValues: unknown[] = []) => {
    const stmt = {
      bind: (...values: unknown[]) => createStatement(query, values),
      first: async () => {
        const table = tables.get('users') ?? [];
        const id = boundValues[0];
        return table.find((r: unknown) => (r as { id: unknown }).id === id) ?? null;
      },
      all: async () => {
        const table = tables.get('users') ?? [];
        return { results: table };
      },
      run: async () => {
        return { success: true, meta: {} };
      },
    };
    return stmt;
  };

  return {
    prepare: (query: string) => createStatement(query),
    batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [] })),
    exec: async (query: string) => ({
      count: 0,
      duration: 0,
    }),
    dump: async () => new ArrayBuffer(0),
    _tables: tables,
  };
}

describe('D1Module', () => {
  it('should inject D1Service with working prepare/first', async () => {
    const mockD1 = createMockD1();
    mockD1._tables.set('users', [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);

    @Controller('/db')
    class DBController {
      constructor(private d1: D1Service) {}

      @Get('/user')
      async getUser() {
        const user = await this.d1.prepare('SELECT * FROM users WHERE id = ?').bind('1').first();
        return { user };
      }
    }

    @Module({
      imports: [D1Module.forRoot({ binding: 'DB' })],
      controllers: [DBController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/db/user', undefined, { DB: mockD1 });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { user: { id: string; name: string } };
    expect(data.user).toEqual({ id: '1', name: 'Alice' });
  });

  it('should support batch operations', async () => {
    const mockD1 = createMockD1();

    @Controller('/db')
    class DBController {
      constructor(private d1: D1Service) {}

      @Get('/batch')
      async batchOp() {
        const stmts = [
          this.d1.prepare('INSERT INTO users VALUES (?, ?)'),
          this.d1.prepare('INSERT INTO users VALUES (?, ?)'),
        ];
        const results = await this.d1.batch(stmts);
        return { count: results.length };
      }
    }

    @Module({
      imports: [D1Module.forRoot({ binding: 'DB' })],
      controllers: [DBController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/db/batch', undefined, { DB: mockD1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
  });

  it('should expose raw database via .database getter', async () => {
    const mockD1 = createMockD1();

    @Controller('/db')
    class DBController {
      constructor(private d1: D1Service) {}

      @Get('/raw')
      async raw() {
        const db = this.d1.database;
        const result = await db.exec('SELECT 1');
        return { result };
      }
    }

    @Module({
      imports: [D1Module.forRoot({ binding: 'DB' })],
      controllers: [DBController],
    })
    class AppModule {}

    const app = await CloudflareFactory.create(AppModule);
    const hono = app.getHonoApp();

    const res = await hono.request('/db/raw', undefined, { DB: mockD1 });
    expect(res.status).toBe(200);
  });
});
