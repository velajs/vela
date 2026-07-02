import { describe, it, expect, beforeEach } from 'vitest';
import { VelaFactory, Module, Injectable, Inject, MetadataRegistry } from '../index.js';
import { Seeder, SeederModule, SeederRegistry, runSeeders } from '../seeder/index.js';

beforeEach(() => {
  MetadataRegistry.clear();
});

describe('SeederModule', () => {
  it('discovers @Seeder providers and runs them in `order`', async () => {
    const calls: string[] = [];

    @Seeder({ order: 2 })
    class SecondSeeder {
      run(): void {
        calls.push('second');
      }
    }

    @Seeder({ order: 1 })
    class FirstSeeder {
      run(): void {
        calls.push('first');
      }
    }

    @Module({ imports: [SeederModule.forRoot({ seeders: [SecondSeeder, FirstSeeder] })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const results = await runSeeders(app);

    expect(calls).toEqual(['first', 'second']);
    expect(results).toEqual([
      { name: 'FirstSeeder', ok: true },
      { name: 'SecondSeeder', ok: true },
    ]);
  });

  it('injects dependencies into seeders', async () => {
    const seeded: unknown[] = [];

    @Injectable()
    class Db {
      insert(row: unknown): void {
        seeded.push(row);
      }
    }

    @Seeder()
    class UserSeeder {
      constructor(@Inject(Db) private readonly db: Db) {}
      run(): void {
        this.db.insert({ user: 'ada' });
      }
    }

    // Seeder + its dep live in the same module (encapsulation), and are
    // discovered from the container regardless of which module declares them.
    @Module({ providers: [Db, UserSeeder], imports: [SeederModule] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    await runSeeders(app);

    expect(seeded).toEqual([{ user: 'ada' }]);
    expect(app.get(SeederRegistry).list().map((s) => s.name)).toEqual(['UserSeeder']);
  });

  it('records failures and stops on the first error by default', async () => {
    const calls: string[] = [];

    @Seeder({ order: 1 })
    class OkSeeder {
      run(): void {
        calls.push('ok');
      }
    }

    @Seeder({ order: 2 })
    class BadSeeder {
      run(): void {
        throw new Error('boom');
      }
    }

    @Seeder({ order: 3 })
    class NeverSeeder {
      run(): void {
        calls.push('never');
      }
    }

    @Module({ imports: [SeederModule.forRoot({ seeders: [OkSeeder, BadSeeder, NeverSeeder] })] })
    class AppModule {}

    const app = await VelaFactory.create(AppModule);
    const results = await runSeeders(app);

    expect(calls).toEqual(['ok']); // stopped before NeverSeeder
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['OkSeeder', true],
      ['BadSeeder', false],
    ]);
  });
});
