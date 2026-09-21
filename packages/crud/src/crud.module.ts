/**
 * `CrudModule` — defineModule-based (the queue-module template), EAGER by
 * design: adapter capability checks, tenant affirmations, and schema
 * derivation are load-time fail-fast wiring, exactly what docs/modules.md
 * says not to defer.
 *
 * - `forRoot({ adapter })` / `forRootAsync` provide the app-wide default
 *   adapter (`CRUD_DEFAULT_ADAPTER`).
 * - `forFeature([defineCrudFeature({ path, model, ... })])` synthesizes a controller per
 *   headless resource and registers its compiled engine under
 *   `crudResourceToken(name)` (options-derived providers, queue-style).
 */

import { Container, defineModule, defineProvider, stableHash } from '@velajs/vela';
import type { DynamicModule } from '@velajs/vela';
import type { CrudAdapter } from './adapter/contract';
import { ConfigurationException } from './envelope/errors';
import type { CrudDatabaseRegistry } from './databases';
import { resolveCrudDatabase } from './resolve-database';
import { compileResource } from './kernel/resource';
import {
  CRUD_DATABASES,
  CRUD_DEFAULT_ADAPTER,
  CRUD_DEFAULT_AUDIT_STORE,
  CRUD_DEFAULT_VERSIONING_STORE,
  crudResourceToken,
} from './crud.tokens';
import { resourceNames } from './crud.types';
import { toEngineConfig } from './stamp-routes';
import { synthesizeController, type CrudFeatureResource } from './synthesize-controller';
import type { VersioningStore } from './versioning/index';
import type { AuditStore } from './audit/index';

export interface CrudModuleOptions {
  /** The app-wide default `CrudAdapter` (per-resource `adapter` overrides it). */
  adapter?: Pick<CrudAdapter, 'runtime'>;
  /** Named database registrations; construct from environment-specific providers. */
  databases?: CrudDatabaseRegistry;
  /** App-wide default version-history store (per-resource `versioningStore` overrides it). */
  versioningStore?: VersioningStore;
  /** App-wide default audit-log store (per-resource `auditStore` overrides it). */
  auditStore?: AuditStore;
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = defineModule<CrudModuleOptions>({
  name: 'Crud',
  key: () => stableHash({ module: 'crud-root' }),
  setup: ({ OPTIONS }) => ({
    providers: [
      defineProvider(CRUD_DATABASES, {
        useFactory: (options) => {
          if (!options.adapter && !options.databases)
            throw new ConfigurationException('CrudModule.forRoot requires adapter or databases');
          return options.databases?.forApplication();
        },
        inject: [OPTIONS],
      }),
      defineProvider(CRUD_DEFAULT_ADAPTER, {
        useFactory: (options) => {
          return (
            options.adapter ?? {
              get runtime(): never {
                throw new ConfigurationException('No default adapter; select a named database');
              },
            }
          );
        },
        inject: [OPTIONS],
      }),
      // Optional app-wide default stores (may be undefined — resources that do
      // not enable versioning/audit never resolve them).
      defineProvider(CRUD_DEFAULT_VERSIONING_STORE, {
        useFactory: (options) => options.versioningStore,
        inject: [OPTIONS],
      }),
      defineProvider(CRUD_DEFAULT_AUDIT_STORE, {
        useFactory: (options) => options.auditStore,
        inject: [OPTIONS],
      }),
    ],
    exports: [
      CRUD_DATABASES,
      CRUD_DEFAULT_ADAPTER,
      CRUD_DEFAULT_VERSIONING_STORE,
      CRUD_DEFAULT_AUDIT_STORE,
    ],
  }),
});

export class CrudModule extends ConfigurableModuleClass {
  /**
   * Mounts headless resources. Controllers are synthesized (and their routes
   * stamped) synchronously here; the compiled engine resource is provided
   * under `crudResourceToken(name)` for anything that wants to dispatch verbs
   * programmatically.
   */
  static forFeature(
    features: CrudFeatureResource[],
    options: { database?: string } = {},
  ): DynamicModule {
    const resources = features.map((feature) => ({
      ...feature,
      config: { ...feature.config, database: feature.config.database ?? options.database },
    }));
    const identities = new Set<string>();
    for (const feature of resources) {
      const name = resourceNames(feature.config).singular;
      const key = JSON.stringify([feature.config.database, name]);
      if (identities.has(key))
        throw new ConfigurationException(`Duplicate CRUD resource '${name}'`);
      identities.add(key);
    }
    const controllers = resources.map((feature) => synthesizeController(feature));
    const providers = resources.map((feature) => {
      const config = feature.config;
      const names = resourceNames(config);
      return defineProvider(crudResourceToken(names.singular, config.database), {
        useFactory: async (container) => {
          const resolved = await resolveCrudDatabase(container, config, {
            name: names.singular,
            identity: feature,
          });
          return compileResource(names.singular, toEngineConfig(resolved, resolved.adapter));
        },
        inject: [Container],
      });
    });

    return {
      module: CrudModule,
      key: `feature:${resources.map((r) => JSON.stringify([r.config.database, r.path])).join(',')}`,
      controllers,
      providers,
      exports: resources.map((feature) =>
        crudResourceToken(resourceNames(feature.config).singular, feature.config.database),
      ),
    };
  }
}

export { MODULE_OPTIONS_TOKEN as CRUD_MODULE_OPTIONS };
