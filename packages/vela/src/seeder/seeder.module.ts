import type { VelaApplication } from '../application';
import { Module } from '../module/decorators';
import { defineModule } from '../module/define-module';
import { stableHash } from '../module/stable-hash';
import type { Type } from '../container/types';
import { SeederRegistry } from './seeder.registry';
import type { SeederResult } from './seeder.types';

export interface SeederModuleOptions {
  seeders?: Type[];
}

const { ConfigurableModuleClass } = defineModule<SeederModuleOptions, 'seeders'>({
  name: 'Seeder',
  structural: ['seeders'],
  // Class references aren't value-hashable — key on the seeder names, the same
  // identity the hand-rolled forRoot used.
  key: (options) => stableHash({ seeders: (options.seeders ?? []).map((s) => s.name) }),
  setup: ({ options }) => ({
    // Register seeder classes as providers so they're discovered at bootstrap.
    // (Seeders declared in other modules' providers are also discovered — this
    // is just a convenience to co-locate them.)
    providers: [...(options.seeders ?? [])],
  }),
});

@Module({
  // Lazy: the @Seeder metadata scan runs when SeederRegistry is first
  // resolved (runSeeders) — hook replay repopulates it correctly.
  lazy: true,
  providers: [SeederRegistry],
  exports: [SeederRegistry],
})
export class SeederModule extends ConfigurableModuleClass {}

/** Convenience runner: resolve the registry from a built app and run all seeders. */
export function runSeeders(
  app: VelaApplication,
  options?: { stopOnError?: boolean },
): Promise<SeederResult[]> {
  return app.get(SeederRegistry).runAll(options);
}
