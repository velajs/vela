import type { VelaApplication } from '../application';
import { Module } from '../module/decorators';
import { stableHash } from '../module/stable-hash';
import type { DynamicModule } from '../module/types';
import type { Type } from '../container/types';
import { SeederRegistry } from './seeder.registry';
import type { SeederResult } from './seeder.types';

@Module({
  providers: [SeederRegistry],
  exports: [SeederRegistry],
})
export class SeederModule {
  /**
   * Register seeder classes as providers so they're discovered at bootstrap.
   * (Seeders declared in other modules' providers are also discovered — this is
   * just a convenience to co-locate them.)
   */
  static forRoot(options: { seeders?: Type[] } = {}): DynamicModule {
    const seeders = options.seeders ?? [];
    return {
      module: SeederModule,
      key: stableHash({ seeders: seeders.map((s) => s.name) }),
      providers: [...seeders],
    };
  }
}

/** Convenience runner: resolve the registry from a built app and run all seeders. */
export function runSeeders(
  app: VelaApplication,
  options?: { stopOnError?: boolean },
): Promise<SeederResult[]> {
  return app.get(SeederRegistry).runAll(options);
}
