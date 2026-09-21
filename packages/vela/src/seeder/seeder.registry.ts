import { Container } from '../container/container';
import { Inject, Injectable } from '../container/index';
import { DiscoveryService } from '../discovery/discovery.service';
import { resolveEntrypoint } from '../entrypoint/execution-context';
import { runInEntrypointScope } from '../entrypoint/execution-scope';
import type { OnApplicationBootstrap } from '../lifecycle/index';
import { SEEDER_METADATA } from './seeder.tokens';
import type { RegisteredSeeder, Seeder, SeederMetadata, SeederResult } from './seeder.types';

/**
 * Discovers `@Seeder()` providers at bootstrap and runs them on demand.
 * Each registration retains its module owner. Metadata-only discovery leaves
 * lazy modules and async/request-scoped providers for the invocation scope.
 */
@Injectable()
export class SeederRegistry implements OnApplicationBootstrap {
  #seeders: RegisteredSeeder[] = [];
  readonly #container: Container;

  constructor(@Inject(Container) container: Container) {
    this.#container = container;
  }

  onApplicationBootstrap(): void {
    const tokenOrder = new Map(this.#container.getTokens().map((token, index) => [token, index]));
    // Keep the public one-argument constructor usable with standalone containers.
    // Discovery itself owns no registrations and performs no provider resolution.
    this.#seeders = new DiscoveryService(this.#container)
      .registrationsWithMeta<SeederMetadata>(SEEDER_METADATA, { metadataOnly: true })
      .map(({ metatype, moduleId, meta }) => ({
        // @Seeder marks the authoring contract; validate the resolved instance
        // before invocation because a custom provider can replace its value.
        target: metatype as RegisteredSeeder['target'],
        moduleId,
        name: meta.name ?? metatype.name,
        order: meta.order ?? 0,
      }))
      .toSorted(
        (a, b) =>
          a.order - b.order || (tokenOrder.get(a.target) ?? 0) - (tokenOrder.get(b.target) ?? 0),
      );
  }

  /** Registered seeders in run order. */
  list(): RegisteredSeeder[] {
    return this.#seeders.map((seeder) => ({ ...seeder }));
  }

  /**
   * Run every registration sequentially in its own managed invocation scope.
   * Async providers and deferred work settle before moving to the next seeder.
   * Returns a per-seeder result; when
   * `stopOnError` is true (default) the run aborts on the first failure.
   */
  async runAll(options: { stopOnError?: boolean } = {}): Promise<SeederResult[]> {
    const stopOnError = options.stopOnError ?? true;
    const results: SeederResult[] = [];
    for (const seeder of this.#seeders) {
      let failed = false;
      try {
        await runInEntrypointScope(this.#container, async (scope) => {
          const instance: unknown = await resolveEntrypoint(scope, {
            token: seeder.target,
            moduleId: seeder.moduleId,
          });
          if (!isSeeder(instance)) {
            throw new TypeError(
              `Seeder '${seeder.name}' in '${seeder.moduleId}' must provide run().`,
            );
          }
          await instance.run();
        });
        results.push({ name: seeder.name, ok: true });
      } catch (error) {
        results.push({ name: seeder.name, ok: false, error });
        failed = true;
      }
      if (failed && stopOnError) break;
    }
    return results;
  }
}

function isSeeder(value: unknown): value is Seeder {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'run' in value &&
    typeof value.run === 'function'
  );
}
