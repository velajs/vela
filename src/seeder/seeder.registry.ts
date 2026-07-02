import { Container } from '../container/container';
import { Inject, Injectable } from '../container/index';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { MetadataRegistry } from '../registry/metadata.registry';
import type { Constructor } from '../registry/types';
import { SEEDER_METADATA } from './seeder.tokens';
import type { RegisteredSeeder, Seeder, SeederMetadata, SeederResult } from './seeder.types';

/**
 * Discovers `@Seeder()` providers at bootstrap and runs them on demand.
 * Mirrors `ScheduleRegistry`'s discovery (scan container tokens → read metadata).
 */
@Injectable()
export class SeederRegistry implements OnApplicationBootstrap {
  private seeders: RegisteredSeeder[] = [];

  constructor(@Inject(Container) private readonly container: Container) {}

  onApplicationBootstrap(): void {
    for (const token of this.container.getTokens()) {
      if (typeof token !== 'function') continue;
      const meta = MetadataRegistry.getCustomClassMeta(token as Constructor, SEEDER_METADATA) as
        | SeederMetadata
        | undefined;
      if (!meta) continue;
      this.seeders.push({
        target: token as RegisteredSeeder['target'],
        name: meta.name ?? (token as Constructor).name,
        order: meta.order ?? 0,
      });
    }
    this.seeders.sort((a, b) => a.order - b.order);
  }

  /** Registered seeders in run order. */
  list(): RegisteredSeeder[] {
    return [...this.seeders];
  }

  /**
   * Run every seeder in order, each in its own request-scoped child container so
   * request-scoped dependencies resolve. Returns a per-seeder result; when
   * `stopOnError` is true (default) the run aborts on the first failure.
   */
  async runAll(options: { stopOnError?: boolean } = {}): Promise<SeederResult[]> {
    const stopOnError = options.stopOnError ?? true;
    const results: SeederResult[] = [];
    for (const seeder of this.seeders) {
      const child = this.container.createChild();
      let failed = false;
      try {
        const instance = child.resolve<Seeder>(seeder.target);
        await instance.run();
        results.push({ name: seeder.name, ok: true });
      } catch (error) {
        results.push({ name: seeder.name, ok: false, error });
        failed = true;
      } finally {
        // Dispose the per-seeder child so its request-scoped disposables clean up.
        await child.dispose();
      }
      if (failed && stopOnError) break;
    }
    return results;
  }
}
