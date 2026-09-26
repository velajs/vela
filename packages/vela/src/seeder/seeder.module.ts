import type { VelaApplication } from '../application';
import { Module } from '../module/decorators';
import { referenceKey } from '../module/reference-key';
import type { DynamicModule } from '../registry/types';
import type { Type } from '../container/types';
import { SeederRegistry } from './seeder.registry';
import type { SeederResult } from './seeder.types';

/** Keeps each feature's seeder providers together for local dependency injection. */
class SeederFeatureModule {}

@Module({
  // Lazy: the @Seeder metadata scan runs when SeederRegistry is first
  // resolved (runSeeders) — hook replay repopulates it correctly.
  lazy: true,
  providers: [SeederRegistry],
  exports: [SeederRegistry],
})
export class SeederModule {
  /** Contribute seeder providers to the application's shared registry. */
  static forFeature(seeders: readonly Type[]): DynamicModule {
    const providers = [...new Set(seeders)];
    return {
      module: SeederFeatureModule,
      key: referenceKey(...providers),
      // Discovery reads metadata; construct seeders in their invocation scope.
      lazy: true,
      imports: [SeederModule],
      providers,
      exports: [SeederModule],
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
