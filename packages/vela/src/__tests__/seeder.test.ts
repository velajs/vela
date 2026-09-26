import { describe, it, expect } from 'vitest';
import { VelaFactory, Module, Injectable, Inject } from '../index.js';
import { Seeder, SeederModule, SeederRegistry, runSeeders } from '../seeder/index.js';

describe('SeederModule', () => {
  it('constructs contributed seeders only when they are run', async () => {
    let constructed = 0;
    let runs = 0;
    @Seeder()
    class DeferredSeeder {
      constructor() {
        constructed++;
      }
      run() {
        runs++;
      }
    }
    @Module({ imports: [SeederModule.forFeature([DeferredSeeder])] })
    class App {}
    const app = await VelaFactory.create(App);
    try {
      expect(constructed).toBe(0);
      expect(app.get(SeederRegistry).list()).toHaveLength(1);
      expect(constructed).toBe(0);
      await runSeeders(app);
      expect(constructed).toBe(1);
      expect(runs).toBe(1);
      await runSeeders(app);
      expect(constructed).toBe(1);
      expect(runs).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('shares one registry and deduplicates repeated readonly feature declarations', async () => {
    const calls: string[] = [];
    @Seeder()
    class ExampleSeeder {
      run() {
        calls.push('example');
      }
    }
    const first = SeederModule.forFeature([ExampleSeeder] as const);
    @Module({ imports: [first, SeederModule.forFeature([] as const)] })
    class Feature {}
    @Module({
      imports: [
        SeederModule,
        Feature,
        first,
        SeederModule.forFeature([ExampleSeeder, ExampleSeeder]),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App);
    expect(app.getContainer().getOwnerModuleIds(SeederRegistry)).toHaveLength(1);
    await runSeeders(app);
    expect(calls).toEqual(['example']);
    await app.close();
  });

  it('injects peer seeders from the same feature owner', async () => {
    const calls: string[] = [];
    @Seeder({ order: 1 })
    class FirstSeeder {
      ready = false;
      run() {
        this.ready = true;
        calls.push('first');
      }
    }
    @Seeder({ order: 2 })
    class SecondSeeder {
      constructor(@Inject(FirstSeeder) private readonly first: FirstSeeder) {}
      run() {
        calls.push(this.first.ready ? 'second' : 'missing-first');
      }
    }
    @Module({ imports: [SeederModule.forFeature([FirstSeeder, SecondSeeder])] })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'throw' });
    try {
      expect(await runSeeders(app)).toEqual([
        { name: 'FirstSeeder', ok: true },
        { name: 'SecondSeeder', ok: true },
      ]);
      expect(calls).toEqual(['first', 'second']);
    } finally {
      await app.close();
    }
  });

  it('shares one registry while distinct features keep separate provider owners', async () => {
    const peers: object[] = [];
    @Seeder()
    class SharedSeeder {
      run() {}
    }
    @Seeder()
    class FirstSeeder {
      constructor(@Inject(SharedSeeder) private readonly shared: SharedSeeder) {}
      run() {
        peers.push(this.shared);
      }
    }
    @Seeder()
    class SecondSeeder {
      constructor(@Inject(SharedSeeder) private readonly shared: SharedSeeder) {}
      run() {
        peers.push(this.shared);
      }
    }
    @Module({
      imports: [
        SeederModule.forFeature([SharedSeeder, FirstSeeder]),
        SeederModule.forFeature([SharedSeeder, SecondSeeder]),
      ],
    })
    class App {}
    const app = await VelaFactory.create(App, { diagnostics: 'throw' });
    try {
      expect(app.getContainer().getOwnerModuleIds(SeederRegistry)).toHaveLength(1);
      expect(app.getContainer().getOwnerModuleIds(SharedSeeder)).toHaveLength(2);
      const results = await runSeeders(app);
      expect(results).toHaveLength(4);
      expect(results.every(({ ok }) => ok)).toBe(true);
      expect(peers).toHaveLength(2);
      expect(peers[0]).not.toBe(peers[1]);
    } finally {
      await app.close();
    }
  });

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

    @Module({ imports: [SeederModule.forFeature([SecondSeeder, FirstSeeder])] })
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
    expect(
      app
        .get(SeederRegistry)
        .list()
        .map((s) => s.name),
    ).toEqual(['UserSeeder']);
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

    @Module({ imports: [SeederModule.forFeature([OkSeeder, BadSeeder, NeverSeeder])] })
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
